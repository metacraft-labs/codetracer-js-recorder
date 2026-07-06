/**
 * AST visitor/transformer for CodeTracer instrumentation.
 *
 * Walks the SWC AST and injects __ct.step/enter/ret calls.
 * Works by directly manipulating the AST as JSON-like objects.
 */

import type {
  Module,
  Statement,
  Expression,
  BlockStatement,
  ModuleItem,
  ArrowFunctionExpression,
  Span,
  ReturnStatement,
  FunctionDeclaration,
  FunctionExpression,
  ClassMethod,
  PrivateMethod,
  Constructor,
  MethodProperty,
  GetterProperty,
  SetterProperty,
} from "@swc/types";
import { ManifestBuilder } from "./manifest.js";
import type { SourceMapResolver } from "./sourcemap.js";

// ---------- helpers for building AST nodes ----------

const DUMMY_SPAN: Span = { start: 0, end: 0, ctxt: 0 };

function mkIdentifier(name: string): Expression {
  return {
    type: "Identifier",
    span: DUMMY_SPAN,
    ctxt: 0,
    value: name,
    optional: false,
  } as unknown as Expression;
}

function mkNumericLiteral(value: number): Expression {
  return {
    type: "NumericLiteral",
    span: DUMMY_SPAN,
    value,
    raw: String(value),
  } as unknown as Expression;
}

function mkMemberExpr(obj: string, prop: string): Expression {
  return {
    type: "MemberExpression",
    span: DUMMY_SPAN,
    object: mkIdentifier(obj),
    property: {
      type: "Identifier",
      span: DUMMY_SPAN,
      value: prop,
    },
  } as unknown as Expression;
}

function mkCallExpr(callee: Expression, args: Expression[]): Expression {
  return {
    type: "CallExpression",
    span: DUMMY_SPAN,
    ctxt: 0,
    callee,
    arguments: args.map((expression) => ({ spread: null, expression })),
    typeArguments: null,
  } as unknown as Expression;
}

function mkExprStmt(expression: Expression): Statement {
  return {
    type: "ExpressionStatement",
    span: DUMMY_SPAN,
    expression,
  } as unknown as Statement;
}

function mkReturnStmt(argument?: Expression): ReturnStatement {
  return {
    type: "ReturnStatement",
    span: DUMMY_SPAN,
    argument: argument ?? null,
  } as unknown as ReturnStatement;
}

function mkBlock(stmts: Statement[]): BlockStatement {
  return {
    type: "BlockStatement",
    span: DUMMY_SPAN,
    ctxt: 0,
    stmts,
  } as unknown as BlockStatement;
}

// ---------- parameter name extraction ----------

/**
 * Extract a readable name from a pattern (parameter binding).
 *
 * Handles simple identifiers and provides placeholder names
 * for destructuring and other complex patterns.
 */
function extractPatternName(pat: unknown, index: number): string {
  if (!pat || typeof pat !== "object") return `_param${index}`;
  const p = pat as { type: string; value?: string; left?: unknown };

  switch (p.type) {
    case "Identifier":
      return p.value ?? `_param${index}`;
    case "AssignmentPattern":
      // e.g., function foo(x = 10) — the left side is the name
      return extractPatternName(p.left, index);
    case "RestElement": {
      // e.g., function foo(...args) — the argument is the name
      const rest = p as { argument?: unknown };
      return "..." + extractPatternName(rest.argument, index);
    }
    case "ObjectPattern":
      return `_param${index}`;
    case "ArrayPattern":
      return `_param${index}`;
    default:
      return `_param${index}`;
  }
}

/**
 * Extract parameter names from a function's params array.
 *
 * SWC wraps each parameter in a `Param { pat: Pattern }` node
 * (for function declarations, function expressions, class methods,
 * constructors). Arrow functions use params directly as Patterns.
 * Constructor params may also be `TsParameterProperty { param }`.
 */
function extractParamNames(params: unknown[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < params.length; i++) {
    const param = params[i] as {
      type?: string;
      pat?: unknown;
      param?: unknown;
    };
    if (param && param.type === "Parameter" && param.pat) {
      // Standard Param node (type is "Parameter" in SWC JSON AST)
      names.push(extractPatternName(param.pat, i));
    } else if (param && param.type === "TsParameterProperty" && param.param) {
      // TypeScript parameter property: constructor(public x: number)
      names.push(extractPatternName(param.param, i));
    } else {
      // Arrow function params are direct patterns (no Param wrapper)
      names.push(extractPatternName(param, i));
    }
  }
  return names;
}

// ---------- __ct call builders ----------

function mkStepCall(siteId: number): Statement {
  return mkExprStmt(
    mkCallExpr(mkMemberExpr("__ct", "step"), [mkNumericLiteral(siteId)]),
  );
}

function mkEnterCall(fnId: number): Statement {
  return mkExprStmt(
    mkCallExpr(mkMemberExpr("__ct", "enter"), [
      mkNumericLiteral(fnId),
      mkIdentifier("arguments"),
    ]),
  );
}

function mkRetExpr(fnId: number, value?: Expression): Expression {
  const args: Expression[] = [mkNumericLiteral(fnId)];
  if (value) args.push(value);
  return mkCallExpr(mkMemberExpr("__ct", "ret"), args);
}

// ---------- M16a: write-call builder ----------

/**
 * Build a synthetic `__ct.write(siteId)` statement.
 *
 * The runtime resolves the metadata for `siteId` from the manifest
 * (target name + RValue description) and emits the corresponding
 * `BindVariable` + `Assignment` pair into its event buffer.  The
 * single-argument shape keeps the bytecode-level call cost minimal
 * and matches the existing `__ct.step(siteId)` pattern.
 */
function mkWriteCall(siteId: number): Statement {
  return mkExprStmt(
    mkCallExpr(mkMemberExpr("__ct", "write"), [mkNumericLiteral(siteId)]),
  );
}

// ---------- M16a: assignment classifier ----------

/**
 * Describes a recognised simple-assignment shape on the RHS of an
 * assignment expression / variable declarator.  Mirrors the
 * `RValue` enum in `codetracer_trace_types` — see the M14 trace-format
 * extension for the canonical wire shape.
 *
 * The visitor emits one of these for every assignment shape it
 * recognises; unknown shapes default to `Compound`.
 */
interface AssignmentRValue {
  kind:
    | "Literal"
    | "Simple"
    | "FieldAccess"
    | "IndexAccess"
    | "FunctionReturn"
    | "Compound";
  source?: string;
  field?: string;
  index?: number;
}

/**
 * Classify an SWC AST expression into an `AssignmentRValue` shape.
 *
 * Recognises the M16a-scoped simple shapes:
 *
 *   * Literals (number / string / bool / null / template literals
 *     without interpolation) -> `Literal`.
 *   * Bare identifiers (`b = a`) -> `Simple { source: "a" }`.
 *   * `obj.field` member access -> `FieldAccess { source: "obj", field: "field" }`.
 *   * `arr[42]` with integer literal index -> `IndexAccess { source: "arr", index: 42 }`.
 *   * `foo(...)` or `obj.method(...)` -> `FunctionReturn`.
 *   * Anything else -> `Compound` (the M14 reader-side compatibility
 *     fallback per the spec).
 *
 * The shapes covered here intentionally match the M16a verification
 * tests; the more elaborate destructuring / spread / nullish / etc.
 * shapes are M16b territory.
 */
function classifyAssignmentRhs(rhs: Expression): AssignmentRValue {
  if (!rhs || typeof rhs !== "object") {
    return { kind: "Compound" };
  }
  const t = (rhs as { type: string }).type;
  switch (t) {
    case "NumericLiteral":
    case "BigIntLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
      return { kind: "Literal" };
    case "TemplateLiteral": {
      // Template literal with no interpolation is a literal; with
      // interpolation it's Compound (each `${expr}` contributes a
      // dependency).  The Compound dependencies are surfaced as
      // best-effort by the runtime side which inspects the live
      // bindings, not the visitor.
      const tl = rhs as unknown as { expressions: Expression[] };
      return tl.expressions.length === 0
        ? { kind: "Literal" }
        : { kind: "Compound" };
    }
    case "Identifier": {
      const id = rhs as unknown as { value?: string };
      if (id.value) {
        return { kind: "Simple", source: id.value };
      }
      return { kind: "Compound" };
    }
    case "MemberExpression": {
      const me = rhs as unknown as {
        object: Expression;
        property: { type: string; value?: string };
        computed?: boolean;
      };
      const obj = me.object as unknown as { type: string; value?: string };
      // SWC MemberExpression carries no `computed` flag when it is a
      // plain `obj.field` access; computed access lands as
      // `property.type === "Computed"` instead.  Be defensive and
      // accept both shapes.
      const propType = me.property?.type;
      if (obj.type === "Identifier" && obj.value) {
        // Static field access: `obj.field`.
        if (propType === "Identifier" && me.property.value) {
          return {
            kind: "FieldAccess",
            source: obj.value,
            field: me.property.value,
          };
        }
        // Computed access (M16b): `arr[42]` or `obj["field"]`.
        if (propType === "Computed") {
          const inner = (me.property as unknown as { expression: Expression })
            .expression;
          const innerT = (inner as { type: string }).type;
          if (innerT === "NumericLiteral") {
            const idx = (inner as unknown as { value: number }).value;
            if (Number.isInteger(idx)) {
              return {
                kind: "IndexAccess",
                source: obj.value,
                index: idx,
              };
            }
          }
          if (innerT === "StringLiteral") {
            const field = (inner as unknown as { value: string }).value;
            return {
              kind: "FieldAccess",
              source: obj.value,
              field,
            };
          }
        }
        // Legacy `me.computed === true` shape (some older SWC builds).
        if (me.computed && propType === "NumericLiteral") {
          const idx = (me.property as unknown as { value: number }).value;
          if (Number.isInteger(idx)) {
            return {
              kind: "IndexAccess",
              source: obj.value,
              index: idx,
            };
          }
        }
      }
      return { kind: "Compound" };
    }
    case "CallExpression":
    case "NewExpression":
    case "TaggedTemplateExpression":
      return { kind: "FunctionReturn" };
    case "OptionalChainingExpression": {
      // M16b: `x = obj?.field` — desugars to a guarded MemberExpression.
      // We classify the underlying base shape so the chain still surfaces
      // as `FieldAccess` (or `IndexAccess` / `FunctionReturn`) when the
      // guard does not fire.  The runtime sees `undefined` for the
      // short-circuit case which the db-backend correlates against the
      // emitted `RValue` via the value snapshot.
      const oce = rhs as unknown as { base: Expression };
      return classifyAssignmentRhs(oce.base);
    }
    case "BinaryExpression": {
      // M16b: nullish coalescing (`a ?? b`) and logical assignment shorts
      // (`a || b`, `a && b`) carry two dependencies.  The M14 vocabulary
      // surfaces this as `Compound` — the precise per-branch
      // classification is left to the db-backend (it observes the
      // post-store value snapshot which tells it which branch was
      // taken).
      const be = rhs as unknown as { operator: string };
      void be;
      return { kind: "Compound" };
    }
    case "ParenthesisExpression": {
      const pe = rhs as unknown as { expression: Expression };
      return classifyAssignmentRhs(pe.expression);
    }
    case "TsAsExpression":
    case "TsSatisfiesExpression":
    case "TsTypeAssertion":
    case "TsConstAssertion":
    case "TsNonNullExpression": {
      const tse = rhs as unknown as { expression: Expression };
      return classifyAssignmentRhs(tse.expression);
    }
    default:
      return { kind: "Compound" };
  }
}

/**
 * Extract the target identifier from a simple LHS pattern.
 * Returns `null` if the pattern is destructured / computed / not
 * a single bare identifier (those shapes are handled by
 * `collectDestructuringWriteSites` per the M16b deliverables).
 */
function extractAssignmentTarget(pat: unknown): string | null {
  if (!pat || typeof pat !== "object") return null;
  const p = pat as { type: string; value?: string };
  if (p.type === "Identifier" && p.value) {
    return p.value;
  }
  return null;
}

// ---------- M16b: destructuring pattern decomposition ----------

/**
 * A single per-element write produced by a destructuring pattern.
 *
 * The recorder lowers `const { a, b } = obj;` into two
 * `__ct.write(siteId)` calls, one per unpacked element.  Each call
 * resolves through the manifest to the `(target, rvalue)` pair
 * described here.
 */
interface DestructuringWrite {
  target: string;
  rvalue: AssignmentRValue;
}

/**
 * Walk a destructuring LHS pattern and emit one `DestructuringWrite`
 * per unpacked element.
 *
 * The classifier handles:
 *
 *   * `ObjectPattern` — `const { a, b } = obj;`, `const { a: x } = obj;`,
 *     nested object/array patterns, defaults (`const { a = 10 } = obj;`).
 *     The `rvalueSource` is taken from the top-level RHS identifier
 *     (when known); the per-element `RValue` is `FieldAccess { source,
 *     field }` keyed on the property name.  Nested patterns recurse with
 *     `rvalue.kind === "Compound"` because the actual sub-expression
 *     read is itself a `FieldAccess` chain the runtime captures via
 *     value snapshots.
 *
 *   * `ArrayPattern` — `const [a, b] = arr;`, holes (`const [, b] = arr;`),
 *     defaults (`const [a, b = 10] = arr;`), and `RestElement`
 *     (`const [a, ...rest] = arr;`).  Element index drives the
 *     `IndexAccess { source, index }` RValue; the rest element is
 *     `Compound` because it carries a synthesised sub-array.
 *
 *   * `RestElement` and `AssignmentPattern` are unwrapped inline.
 *
 * The walker uses the `rhsSource` parameter (the top-level RHS
 * identifier name when the RHS is a bare `Identifier`) to populate
 * the `source` field on `FieldAccess` / `IndexAccess`.  When the RHS
 * is not a bare identifier, `source` is left undefined and the
 * db-backend correlates via the value snapshot.
 *
 * Computed property keys (`const { [k]: val } = obj;`) surface as
 * `Compound` because the key cannot be resolved statically.
 *
 * Reference: M16b deliverable 1.
 */
function collectDestructuringWrites(
  pat: unknown,
  rhsSource: string | undefined,
): DestructuringWrite[] {
  const writes: DestructuringWrite[] = [];
  collectDestructuringWritesInto(pat, rhsSource, writes);
  return writes;
}

function collectDestructuringWritesInto(
  pat: unknown,
  rhsSource: string | undefined,
  out: DestructuringWrite[],
): void {
  if (!pat || typeof pat !== "object") return;
  const p = pat as { type: string };

  switch (p.type) {
    case "Identifier": {
      // Bare identifier as a sub-pattern is handled by the caller
      // (object/array property walkers know the field/index and
      // construct the `RValue` themselves).
      return;
    }
    case "AssignmentPattern": {
      // `const { a = 10 } = obj` / `const [a = 10] = arr` —
      // the default is irrelevant for write-site bookkeeping;
      // recurse into the left-hand pattern.
      const ap = pat as { left: unknown };
      collectDestructuringWritesInto(ap.left, rhsSource, out);
      return;
    }
    case "ObjectPattern": {
      const op = pat as {
        properties: Array<{
          type: string;
          key?: { type: string; value?: string; expression?: Expression };
          value?: unknown;
        }>;
      };
      for (const prop of op.properties) {
        if (prop.type === "AssignmentPatternProperty") {
          // Shorthand: `{ a }` or `{ a = 10 }` (key.value is the name).
          const keyName = prop.key?.value;
          if (!keyName) continue;
          out.push({
            target: keyName,
            rvalue: {
              kind: "FieldAccess",
              source: rhsSource,
              field: keyName,
            },
          });
        } else if (prop.type === "KeyValuePatternProperty") {
          // Renaming: `{ a: x }` — the key is the field, value is the
          // sub-pattern (identifier or nested pattern).  Computed
          // property keys (`{ [k]: val }`) fall back to Compound
          // because the key is not statically known.
          const keyType = prop.key?.type;
          const field = prop.key?.value;
          const sub = prop.value as { type?: string; value?: string };

          if (keyType === "Computed") {
            // Computed key: target name comes from the value
            // sub-pattern (identifier), RValue is Compound.
            if (sub && sub.type === "Identifier" && sub.value) {
              out.push({
                target: sub.value,
                rvalue: { kind: "Compound" },
              });
            } else {
              // Nested pattern under computed key — recurse with
              // no source-field bookkeeping.
              collectDestructuringWritesInto(sub, undefined, out);
            }
            continue;
          }

          if (!field) continue;

          if (sub && sub.type === "Identifier" && sub.value) {
            // `{ a: x }` — `x` is bound to `obj.a`.
            out.push({
              target: sub.value,
              rvalue: {
                kind: "FieldAccess",
                source: rhsSource,
                field,
              },
            });
          } else if (sub && sub.type === "AssignmentPattern") {
            // `{ a: x = 10 }` — unwrap.
            const apSub = sub as unknown as { left: unknown };
            const left = apSub.left as { type?: string; value?: string };
            if (left && left.type === "Identifier" && left.value) {
              out.push({
                target: left.value,
                rvalue: {
                  kind: "FieldAccess",
                  source: rhsSource,
                  field,
                },
              });
            } else {
              collectDestructuringWritesInto(left, undefined, out);
            }
          } else {
            // Nested pattern: `{ a: { b } } = obj` — recurse without
            // a known sub-source identifier (the nested RHS is
            // `obj.a`, not a top-level bare identifier).
            collectDestructuringWritesInto(sub, undefined, out);
          }
        } else if (prop.type === "RestElement") {
          // `const { a, ...rest } = obj` — rest binds to a fresh
          // object containing the remaining own enumerable keys.
          const restArg = (prop as unknown as { argument: unknown }).argument;
          const ra = restArg as { type?: string; value?: string };
          if (ra && ra.type === "Identifier" && ra.value) {
            out.push({
              target: ra.value,
              rvalue: { kind: "Compound", source: rhsSource },
            });
          }
        }
      }
      return;
    }
    case "ArrayPattern": {
      const ap = pat as { elements: Array<unknown | null> };
      for (let i = 0; i < ap.elements.length; i++) {
        const el = ap.elements[i];
        if (el === null || el === undefined) continue;
        const elTyped = el as { type: string; value?: string };
        if (elTyped.type === "Identifier" && elTyped.value) {
          out.push({
            target: elTyped.value,
            rvalue: {
              kind: "IndexAccess",
              source: rhsSource,
              index: i,
            },
          });
        } else if (elTyped.type === "AssignmentPattern") {
          // `const [a = 10] = arr` — unwrap.
          const apEl = el as unknown as { left: unknown };
          const left = apEl.left as { type?: string; value?: string };
          if (left && left.type === "Identifier" && left.value) {
            out.push({
              target: left.value,
              rvalue: {
                kind: "IndexAccess",
                source: rhsSource,
                index: i,
              },
            });
          } else {
            collectDestructuringWritesInto(left, undefined, out);
          }
        } else if (elTyped.type === "RestElement") {
          // `const [a, ...rest] = arr` — rest is a fresh array slice.
          // The M16b spec calls this out specifically: emit a write
          // event with `Compound` because the slice is a derived
          // composite, not a single index lookup.
          const restArg = (el as unknown as { argument: unknown }).argument;
          const ra = restArg as { type?: string; value?: string };
          if (ra && ra.type === "Identifier" && ra.value) {
            out.push({
              target: ra.value,
              rvalue: { kind: "Compound", source: rhsSource },
            });
          }
        } else if (
          elTyped.type === "ObjectPattern" ||
          elTyped.type === "ArrayPattern"
        ) {
          // Nested destructuring inside array: `const [a, [b, c]] = nested`.
          // The nested sub-RHS is `nested[1]`; we do not have a bare
          // identifier name for that, so recurse without a source.
          collectDestructuringWritesInto(el, undefined, out);
        }
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Detect whether an LHS pattern is a destructuring pattern (and thus
 * needs `collectDestructuringWrites` rather than the simple-target path).
 */
function isDestructuringPattern(pat: unknown): boolean {
  if (!pat || typeof pat !== "object") return false;
  const p = pat as { type: string };
  return p.type === "ObjectPattern" || p.type === "ArrayPattern";
}

/**
 * Best-effort: pull a bare identifier source name out of an expression
 * for use as the `RValue.source` field on destructuring writes.
 * Returns `undefined` for anything that is not a bare identifier so the
 * destructuring walker leaves the source unresolved (the db-backend
 * falls back to the value-snapshot correlation in that case).
 */
function extractBareIdentifier(
  expr: Expression | undefined,
): string | undefined {
  if (!expr || typeof expr !== "object") return undefined;
  const e = expr as { type: string; value?: string };
  if (e.type === "Identifier" && e.value) return e.value;
  if (e.type === "ParenthesisExpression") {
    const pe = expr as unknown as { expression: Expression };
    return extractBareIdentifier(pe.expression);
  }
  return undefined;
}

// ---------- line/column mapper ----------

export class LineColMapper {
  private lineStarts: number[];
  /**
   * The base offset from the SWC global span counter.
   * SWC uses a global offset counter across parseSync calls,
   * so the first file starts at 1, and subsequent files start
   * from where the previous file ended. This base offset is
   * subtracted from span offsets before resolving to line/col.
   */
  private baseOffset: number;

  constructor(source: string, baseOffset: number = 1) {
    this.baseOffset = baseOffset;
    this.lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") {
        this.lineStarts.push(i + 1);
      }
    }
  }

  /**
   * Convert a SWC span offset (global) to { line, col } (both 1-based).
   * The line is 1-based, col is 0-based.
   */
  resolve(offset: number): { line: number; col: number } {
    // Subtract the base offset to get a 0-based position within the source
    const pos = offset - this.baseOffset;
    // Clamp to valid range
    const clampedPos = Math.max(
      0,
      Math.min(pos, this.lineStarts[this.lineStarts.length - 1] || 0),
    );
    // Binary search for the line
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= clampedPos) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo + 1, col: clampedPos - this.lineStarts[lo] };
  }
}

// ---------- directive prologue detection ----------

/**
 * Checks if a statement is a directive prologue ("use strict", etc.)
 */
function isDirective(stmt: Statement): boolean {
  if (stmt.type !== "ExpressionStatement") return false;
  const es = stmt as { expression: { type: string; value?: string } };
  return es.expression.type === "StringLiteral";
}

/**
 * Returns the number of leading directive prologue statements.
 */
function directivePrologueCount(stmts: Statement[]): number {
  let count = 0;
  for (const s of stmts) {
    if (isDirective(s)) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ---------- super() detection for constructors ----------

/**
 * Check if a statement is a super() call (possibly with arguments).
 */
function isSuperCall(stmt: Statement): boolean {
  if (stmt.type !== "ExpressionStatement") return false;
  const expr = (
    stmt as { expression: { type: string; callee?: { type: string } } }
  ).expression;
  return expr.type === "CallExpression" && expr.callee?.type === "Super";
}

/**
 * Find the index of the super() call in a constructor body.
 * Returns -1 if not found.
 */
function findSuperCallIndex(stmts: Statement[]): number {
  for (let i = 0; i < stmts.length; i++) {
    if (isSuperCall(stmts[i])) return i;
  }
  return -1;
}

// ---------- check if function body has explicit return ----------

function hasExplicitReturn(stmts: Statement[]): boolean {
  for (const stmt of stmts) {
    if (stmt.type === "ReturnStatement") return true;
    // Check nested blocks but not nested functions (returns in nested functions don't count)
    if (stmt.type === "BlockStatement") {
      if (hasExplicitReturn((stmt as BlockStatement).stmts)) return true;
    }
    if (stmt.type === "IfStatement") {
      const ifStmt = stmt as { consequent: Statement; alternate?: Statement };
      if (ifStmt.consequent.type === "ReturnStatement") return true;
      if (
        ifStmt.consequent.type === "BlockStatement" &&
        hasExplicitReturn((ifStmt.consequent as BlockStatement).stmts)
      )
        return true;
      if (ifStmt.alternate) {
        if (ifStmt.alternate.type === "ReturnStatement") return true;
        if (
          ifStmt.alternate.type === "BlockStatement" &&
          hasExplicitReturn((ifStmt.alternate as BlockStatement).stmts)
        )
          return true;
      }
    }
    if (stmt.type === "SwitchStatement") {
      const sw = stmt as { cases: Array<{ consequent: Statement[] }> };
      for (const c of sw.cases) {
        if (hasExplicitReturn(c.consequent)) return true;
      }
    }
    if (stmt.type === "TryStatement") {
      const tr = stmt as {
        block: BlockStatement;
        handler?: { body: BlockStatement };
        finalizer?: BlockStatement;
      };
      if (hasExplicitReturn(tr.block.stmts)) return true;
      if (tr.handler && hasExplicitReturn(tr.handler.body.stmts)) return true;
      if (tr.finalizer && hasExplicitReturn(tr.finalizer.stmts)) return true;
    }
    // Loop bodies
    if (
      stmt.type === "WhileStatement" ||
      stmt.type === "DoWhileStatement" ||
      stmt.type === "ForStatement" ||
      stmt.type === "ForInStatement" ||
      stmt.type === "ForOfStatement"
    ) {
      const loop = stmt as { body: Statement };
      if (loop.body.type === "ReturnStatement") return true;
      if (
        loop.body.type === "BlockStatement" &&
        hasExplicitReturn((loop.body as BlockStatement).stmts)
      )
        return true;
    }
    if (stmt.type === "LabeledStatement") {
      const labeled = stmt as { body: Statement };
      if (labeled.body.type === "ReturnStatement") return true;
      if (
        labeled.body.type === "BlockStatement" &&
        hasExplicitReturn((labeled.body as BlockStatement).stmts)
      )
        return true;
    }
  }
  return false;
}

// ---------- ensure block wrapping for single-statement bodies ----------

/**
 * If a statement is not a BlockStatement, wrap it in one.
 * Returns the BlockStatement.
 */
function ensureBlock(stmt: Statement): BlockStatement {
  if (stmt.type === "BlockStatement") return stmt as BlockStatement;
  return mkBlock([stmt]);
}

// ---------- main transformer ----------

export interface TransformContext {
  manifest: ManifestBuilder;
  pathIndex: number;
  mapper: LineColMapper;
  /**
   * Optional source map resolver for mapping generated-JS positions
   * back to original source positions. When set, manifest entries
   * will use original file paths and line numbers.
   */
  sourceMapResolver?: SourceMapResolver;
  /**
   * Resolve a generated-JS location to the manifest path index and
   * original line/col. If a source map resolver is configured, it will
   * attempt to resolve to the original position. Falls back to the
   * generated position.
   */
  resolveLocation: (
    line: number,
    col: number,
  ) => { pathIndex: number; line: number; col: number };
}

/**
 * Helper: resolve a SWC span start offset to manifest location
 * (pathIndex, line, col), going through the source map if available.
 */
function resolveSpan(
  spanStart: number,
  ctx: TransformContext,
): { pathIndex: number; line: number; col: number } {
  const loc = ctx.mapper.resolve(spanStart);
  return ctx.resolveLocation(loc.line, loc.col);
}

function spanStartOf(node: unknown): number | undefined {
  const span = (node as { span?: { start?: unknown } } | undefined)?.span;
  return typeof span?.start === "number" ? span.start : undefined;
}

/**
 * Transform an SWC Module AST in-place, injecting __ct instrumentation.
 */
export function transformModule(module: Module, ctx: TransformContext): void {
  // Register a top-level "module" function
  const modLoc = ctx.resolveLocation(1, 0);
  const moduleFnId = ctx.manifest.addFunction(
    "<module>",
    modLoc.pathIndex,
    modLoc.line,
    modLoc.col,
  );
  ctx.manifest.addCallSite(
    moduleFnId,
    modLoc.pathIndex,
    modLoc.line,
    modLoc.col,
  );

  // Process module body items
  const newBody: ModuleItem[] = [];

  // Count directive prologues in module body
  // Module items can be statements or module declarations; only statements can be directives
  let directiveCount = 0;
  for (const item of module.body) {
    if ("type" in item && isDirective(item as Statement)) {
      directiveCount++;
    } else {
      break;
    }
  }

  // Add directives first
  for (let i = 0; i < directiveCount; i++) {
    newBody.push(module.body[i]);
  }

  // Add __ct.enter for the module
  newBody.push(mkEnterCall(moduleFnId) as unknown as ModuleItem);

  // Process remaining items
  for (let i = directiveCount; i < module.body.length; i++) {
    const item = module.body[i];
    transformModuleItem(item, ctx);

    // Insert step before executable statements (not import/export declarations)
    if (isExecutableModuleItem(item)) {
      const span = (item as unknown as { span: Span }).span;
      const resolved = resolveSpan(span.start, ctx);
      const siteId = ctx.manifest.addStepSite(
        resolved.pathIndex,
        resolved.line,
        resolved.col,
      );
      newBody.push(mkStepCall(siteId) as unknown as ModuleItem);
    }

    newBody.push(item);

    // M16a: emit one __ct.write call per recognised simple-assignment
    // shape in the top-level statement.  Module-level `const`/`let`
    // declarations are the common case here (entry-point scripts).
    if ("type" in item) {
      for (const siteId of collectAssignmentSitesFromStatement(
        item as unknown as Statement,
        ctx,
      )) {
        newBody.push(mkWriteCall(siteId) as unknown as ModuleItem);
      }
    }
  }

  // Add __ct.ret at module end
  const retSiteId = ctx.manifest.addReturnSite(
    moduleFnId,
    modLoc.pathIndex,
    modLoc.line,
    modLoc.col,
  );
  void retSiteId;
  newBody.push(mkExprStmt(mkRetExpr(moduleFnId)) as unknown as ModuleItem);

  module.body = newBody;
}

/**
 * Check if a module item is an executable statement (not a pure declaration like import/export).
 */
function isExecutableModuleItem(item: ModuleItem): boolean {
  const t = (item as { type: string }).type;
  // Module declarations that are NOT executable
  if (
    t === "ImportDeclaration" ||
    t === "ExportAllDeclaration" ||
    t === "ExportNamedDeclaration" ||
    t === "TsImportEqualsDeclaration" ||
    t === "TsExportAssignment" ||
    t === "TsNamespaceExportDeclaration" ||
    t === "TsInterfaceDeclaration" ||
    t === "TsTypeAliasDeclaration" ||
    t === "TsModuleDeclaration"
  ) {
    return false;
  }
  // ExportDeclaration and ExportDefaultDeclaration/ExportDefaultExpression contain executable code
  // but we'll treat them as executable items
  if (t === "EmptyStatement") return false;
  return true;
}

/**
 * Transform a module item in-place — descend into functions, classes, etc.
 */
function transformModuleItem(item: ModuleItem, ctx: TransformContext): void {
  const t = (item as { type: string }).type;

  if (t === "ExportDeclaration") {
    const ed = item as unknown as { declaration: Statement };
    transformStatement(ed.declaration, ctx);
    return;
  }

  if (t === "ExportDefaultDeclaration") {
    const edd = item as unknown as { decl: { type: string } };
    if (edd.decl.type === "FunctionExpression") {
      transformFunctionExpression(
        edd.decl as unknown as FunctionExpression,
        ctx,
      );
    } else if (edd.decl.type === "ClassExpression") {
      transformClassBody(
        edd.decl as unknown as { body: Array<{ type: string }> },
        ctx,
      );
    }
    return;
  }

  if (t === "ExportDefaultExpression") {
    const ede = item as unknown as { expression: Expression };
    transformExpression(ede.expression, ctx);
    return;
  }

  // For statements, delegate
  if (isStatementType(t)) {
    transformStatement(item as unknown as Statement, ctx);
  }
}

function isStatementType(t: string): boolean {
  return (
    t === "BlockStatement" ||
    t === "EmptyStatement" ||
    t === "DebuggerStatement" ||
    t === "WithStatement" ||
    t === "ReturnStatement" ||
    t === "LabeledStatement" ||
    t === "BreakStatement" ||
    t === "ContinueStatement" ||
    t === "IfStatement" ||
    t === "SwitchStatement" ||
    t === "ThrowStatement" ||
    t === "TryStatement" ||
    t === "WhileStatement" ||
    t === "DoWhileStatement" ||
    t === "ForStatement" ||
    t === "ForInStatement" ||
    t === "ForOfStatement" ||
    t === "ExpressionStatement" ||
    t === "FunctionDeclaration" ||
    t === "ClassDeclaration" ||
    t === "VariableDeclaration"
  );
}

// ---------- statement transformer ----------

function transformStatement(stmt: Statement, ctx: TransformContext): void {
  switch (stmt.type) {
    case "FunctionDeclaration":
      transformFunctionDecl(stmt as FunctionDeclaration, ctx);
      break;
    case "ClassDeclaration": {
      const cd = stmt as unknown as { body: Array<{ type: string }> };
      transformClassBody(cd, ctx);
      break;
    }
    case "VariableDeclaration": {
      const vd = stmt as unknown as {
        declarations: Array<{ init?: Expression }>;
      };
      for (const decl of vd.declarations) {
        if (decl.init) {
          transformExpression(decl.init, ctx);
        }
      }
      break;
    }
    case "ExpressionStatement": {
      const es = stmt as unknown as { expression: Expression };
      transformExpression(es.expression, ctx);
      break;
    }
    case "IfStatement": {
      const is = stmt as unknown as {
        test: Expression;
        consequent: Statement;
        alternate?: Statement;
      };
      transformExpression(is.test, ctx);

      // Ensure block for consequent
      is.consequent = ensureBlock(is.consequent);
      transformBlockBody((is.consequent as BlockStatement).stmts, ctx);

      if (is.alternate) {
        if (is.alternate.type !== "IfStatement") {
          is.alternate = ensureBlock(is.alternate);
          transformBlockBody((is.alternate as BlockStatement).stmts, ctx);
        } else {
          transformStatement(is.alternate, ctx);
        }
      }
      break;
    }
    case "WhileStatement":
    case "DoWhileStatement": {
      const ws = stmt as unknown as { test: Expression; body: Statement };
      transformExpression(ws.test, ctx);
      ws.body = ensureBlock(ws.body);
      transformBlockBody((ws.body as BlockStatement).stmts, ctx);
      break;
    }
    case "ForStatement": {
      const fs = stmt as unknown as {
        init?:
          | { type: string; declarations?: Array<{ init?: Expression }> }
          | Expression;
        test?: Expression;
        update?: Expression;
        body: Statement;
      };
      if (fs.init) {
        if ((fs.init as { type: string }).type === "VariableDeclaration") {
          const vd = fs.init as { declarations: Array<{ init?: Expression }> };
          for (const d of vd.declarations) {
            if (d.init) transformExpression(d.init, ctx);
          }
        } else {
          transformExpression(fs.init as Expression, ctx);
        }
      }
      if (fs.test) transformExpression(fs.test, ctx);
      if (fs.update) transformExpression(fs.update, ctx);
      fs.body = ensureBlock(fs.body);
      transformBlockBody((fs.body as BlockStatement).stmts, ctx);
      break;
    }
    case "ForInStatement":
    case "ForOfStatement": {
      const fis = stmt as unknown as { right: Expression; body: Statement };
      transformExpression(fis.right, ctx);
      fis.body = ensureBlock(fis.body);
      transformBlockBody((fis.body as BlockStatement).stmts, ctx);
      break;
    }
    case "SwitchStatement": {
      const ss = stmt as unknown as {
        discriminant: Expression;
        cases: Array<{ consequent: Statement[] }>;
      };
      transformExpression(ss.discriminant, ctx);
      for (const c of ss.cases) {
        transformBlockBody(c.consequent, ctx);
      }
      break;
    }
    case "TryStatement": {
      const ts = stmt as unknown as {
        block: BlockStatement;
        handler?: { body: BlockStatement; param?: unknown };
        finalizer?: BlockStatement;
      };
      transformBlockBody(ts.block.stmts, ctx);
      if (ts.handler) {
        transformBlockBody(ts.handler.body.stmts, ctx);
      }
      if (ts.finalizer) {
        transformBlockBody(ts.finalizer.stmts, ctx);
      }
      break;
    }
    case "ThrowStatement": {
      const thrw = stmt as unknown as { argument: Expression };
      transformExpression(thrw.argument, ctx);
      break;
    }
    case "LabeledStatement": {
      const ls = stmt as unknown as { body: Statement };
      transformStatement(ls.body, ctx);
      break;
    }
    case "BlockStatement": {
      const bs = stmt as BlockStatement;
      transformBlockBody(bs.stmts, ctx);
      break;
    }
    case "ReturnStatement": {
      const rs = stmt as unknown as { argument?: Expression };
      if (rs.argument) transformExpression(rs.argument, ctx);
      break;
    }
    case "WithStatement": {
      const ws2 = stmt as unknown as { object: Expression; body: Statement };
      transformExpression(ws2.object, ctx);
      ws2.body = ensureBlock(ws2.body);
      transformBlockBody((ws2.body as BlockStatement).stmts, ctx);
      break;
    }
    default:
      // EmptyStatement, DebuggerStatement, BreakStatement, ContinueStatement, TS declarations
      break;
  }
}

/**
 * Transform statements inside a block, inserting step calls.
 * Modifies the array in-place.
 *
 * M16a: after the original statement we also emit one
 * `__ct.write(siteId)` call per recognised simple-assignment shape
 * (see `collectAssignmentSitesFromStatement`).  The write call lands
 * *after* the statement so the runtime observes the post-store
 * value when it inspects the live binding.
 */
function transformBlockBody(stmts: Statement[], ctx: TransformContext): void {
  const newStmts: Statement[] = [];
  for (const stmt of stmts) {
    // Recurse into the statement first to handle nested functions, etc.
    transformStatement(stmt, ctx);

    // Insert step call before executable statements
    if (isExecutableStatement(stmt)) {
      const span = (stmt as unknown as { span: Span }).span;
      const resolved = resolveSpan(span.start, ctx);
      const siteId = ctx.manifest.addStepSite(
        resolved.pathIndex,
        resolved.line,
        resolved.col,
      );
      newStmts.push(mkStepCall(siteId));
    }
    newStmts.push(stmt);

    // M16a: emit __ct.write calls for any simple-assignment shapes
    // recognised in this statement.  We do this AFTER the statement
    // so the runtime sees the post-store value when it inspects the
    // live binding via the manifest's target name.
    for (const siteId of collectAssignmentSitesFromStatement(stmt, ctx)) {
      newStmts.push(mkWriteCall(siteId));
    }
  }

  // Replace contents in-place
  stmts.length = 0;
  stmts.push(...newStmts);
}

/**
 * M16a: walk a statement's AST and register write-site manifest
 * entries for every recognised simple-assignment shape.  Returns the
 * list of `siteId`s the caller should emit `__ct.write` calls for.
 *
 * Recognised shapes (see `classifyAssignmentRhs` for the RHS
 * variants):
 *
 *   * `VariableDeclaration` with a single identifier binder:
 *     `let x = expr`, `const b = a`.  We register one write site per
 *     declarator with a non-destructuring identifier LHS — the M14
 *     spec carries one Assignment event per LHS bind, so multiple
 *     declarators in `let a = 1, b = 2;` get two write sites.
 *   * `AssignmentExpression` with an Identifier LHS:
 *     `a = expr`, `a += expr`, `a -= expr`, `a *= expr`, `a /= expr`.
 *     Compound assignment ops (`+= -= *= /=`) are classified as
 *     `Compound([source_of_rhs, prev_value_of_lhs])` per the M14 spec
 *     because the RHS implicitly depends on the LHS's prior value.
 *     For simplicity we surface them as `Compound`, leaving the more
 *     precise classification to the db-backend.
 *
 * Other shapes (destructuring, computed property assignment, etc.)
 * fall through with no write site emitted.  Those are M16b
 * territory and the lack of a write site is the M16a contract: the
 * db-backend falls back to Path B for them.
 */
function collectAssignmentSitesFromStatement(
  stmt: Statement,
  ctx: TransformContext,
): number[] {
  const siteIds: number[] = [];

  /**
   * Helper: register every destructuring write produced by an LHS
   * pattern against the RHS init expression.  Returns the list of
   * siteIds registered.  M16b deliverable 2 — runtime-dynamic
   * destructuring widths surface as one write site per unpacked
   * element.
   */
  const emitDestructuringWriteSites = (
    pat: unknown,
    init: Expression,
    span: Span,
  ): void => {
    const rhsSource = extractBareIdentifier(init);
    const writes = collectDestructuringWrites(pat, rhsSource);
    if (writes.length === 0) return;
    const resolved = resolveSpan(span.start, ctx);
    for (const w of writes) {
      const id = ctx.manifest.addWriteSite(
        resolved.pathIndex,
        resolved.line,
        resolved.col,
        w.target,
        w.rvalue.kind,
        {
          source: w.rvalue.source,
          field: w.rvalue.field,
          index: w.rvalue.index,
        },
      );
      siteIds.push(id);
    }
  };

  if (stmt.type === "VariableDeclaration") {
    const vd = stmt as unknown as {
      declarations: Array<{
        type: string;
        id: unknown;
        init?: Expression;
        span?: Span;
      }>;
    };
    for (const decl of vd.declarations) {
      if (!decl.init) continue;
      const span =
        (decl as { span?: Span }).span ??
        (stmt as unknown as { span: Span }).span;

      // M16b: destructuring LHS — emit one write site per unpacked
      // element.  The runtime sees runtime-dynamic widths via the
      // per-element manifest entry rather than a single packed site.
      if (isDestructuringPattern(decl.id)) {
        emitDestructuringWriteSites(decl.id, decl.init, span);
        continue;
      }

      const target = extractAssignmentTarget(decl.id);
      if (target === null) continue;
      const rvalue = classifyAssignmentRhs(decl.init);
      const resolved = resolveSpan(span.start, ctx);
      const siteId = ctx.manifest.addWriteSite(
        resolved.pathIndex,
        resolved.line,
        resolved.col,
        target,
        rvalue.kind,
        {
          source: rvalue.source,
          field: rvalue.field,
          index: rvalue.index,
        },
      );
      siteIds.push(siteId);
    }
    return siteIds;
  }

  if (stmt.type === "ExpressionStatement") {
    const es = stmt as unknown as { expression: Expression };
    let expr = es.expression;
    // Unwrap parenthesised assignment: `({ a, b } = obj);`.
    if (expr && (expr as { type: string }).type === "ParenthesisExpression") {
      expr = (expr as unknown as { expression: Expression }).expression;
    }
    if (expr && (expr as { type: string }).type === "AssignmentExpression") {
      const ae = expr as unknown as {
        operator?: string;
        left: Expression;
        right: Expression;
        span?: Span;
      };
      const span = ae.span ?? (stmt as unknown as { span: Span }).span;

      // M16b: destructuring assignment expression — `({ a, b } = obj)`
      // or `[a, b] = arr` — emit one write site per unpacked element.
      if (
        (ae.operator === undefined || ae.operator === "=") &&
        isDestructuringPattern(ae.left)
      ) {
        emitDestructuringWriteSites(ae.left, ae.right, span);
        return siteIds;
      }

      const target = extractAssignmentTarget(ae.left);
      if (target !== null) {
        // Compound-assignment operators (`+=` etc.) carry an implicit
        // load-of-target; classify as Compound to express the
        // dependency on the prior value.  The bare `=` case uses the
        // full RHS classifier.
        const rvalue: AssignmentRValue =
          ae.operator && ae.operator !== "="
            ? { kind: "Compound" }
            : classifyAssignmentRhs(ae.right);
        const resolved = resolveSpan(span.start, ctx);
        const siteId = ctx.manifest.addWriteSite(
          resolved.pathIndex,
          resolved.line,
          resolved.col,
          target,
          rvalue.kind,
          {
            source: rvalue.source,
            field: rvalue.field,
            index: rvalue.index,
          },
        );
        siteIds.push(siteId);
      }
    }
  }

  return siteIds;
}

function isExecutableStatement(stmt: Statement): boolean {
  const t = stmt.type;
  if (t === "EmptyStatement") return false;
  // Don't count type-only declarations
  if (
    t === "TsInterfaceDeclaration" ||
    t === "TsTypeAliasDeclaration" ||
    t === "TsModuleDeclaration"
  )
    return false;
  return true;
}

// ---------- expression transformer (descend into nested functions) ----------

function transformExpression(expr: Expression, ctx: TransformContext): void {
  if (!expr || typeof expr !== "object") return;

  const t = (expr as { type: string }).type;

  switch (t) {
    case "ArrowFunctionExpression":
      transformArrowFunction(expr as unknown as ArrowFunctionExpression, ctx);
      break;
    case "FunctionExpression":
      transformFunctionExpression(expr as unknown as FunctionExpression, ctx);
      break;
    case "ClassExpression": {
      const ce = expr as unknown as { body: Array<{ type: string }> };
      transformClassBody(ce, ctx);
      break;
    }
    case "CallExpression":
    case "NewExpression": {
      const ce = expr as unknown as {
        callee: Expression;
        arguments?: Array<{ expression: Expression }>;
      };
      if (
        ce.callee &&
        (ce.callee as { type: string }).type !== "Super" &&
        (ce.callee as { type: string }).type !== "Import"
      ) {
        transformExpression(ce.callee, ctx);
      }
      if (ce.arguments) {
        for (const arg of ce.arguments) {
          transformExpression(arg.expression, ctx);
        }
      }
      break;
    }
    case "MemberExpression":
    case "SuperPropExpression": {
      const me = expr as unknown as {
        object?: Expression;
        property?: Expression;
      };
      if (me.object) transformExpression(me.object, ctx);
      break;
    }
    case "AssignmentExpression": {
      const ae = expr as unknown as { left: Expression; right: Expression };
      transformExpression(ae.right, ctx);
      break;
    }
    case "BinaryExpression": {
      const be = expr as unknown as { left: Expression; right: Expression };
      transformExpression(be.left, ctx);
      transformExpression(be.right, ctx);
      break;
    }
    case "ConditionalExpression": {
      const ce2 = expr as unknown as {
        test: Expression;
        consequent: Expression;
        alternate: Expression;
      };
      transformExpression(ce2.test, ctx);
      transformExpression(ce2.consequent, ctx);
      transformExpression(ce2.alternate, ctx);
      break;
    }
    case "UnaryExpression":
    case "UpdateExpression":
    case "AwaitExpression": {
      const ue = expr as unknown as { argument: Expression };
      transformExpression(ue.argument, ctx);
      break;
    }
    case "SequenceExpression": {
      const se = expr as unknown as { expressions: Expression[] };
      for (const e of se.expressions) {
        transformExpression(e, ctx);
      }
      break;
    }
    case "ArrayExpression": {
      const ae2 = expr as unknown as {
        elements: Array<{ expression?: Expression } | undefined>;
      };
      for (const el of ae2.elements) {
        if (el && el.expression) transformExpression(el.expression, ctx);
      }
      break;
    }
    case "ObjectExpression": {
      const oe = expr as unknown as {
        properties: Array<{
          type: string;
          value?: Expression;
          function?: { body?: BlockStatement };
          body?: BlockStatement;
          param?: unknown;
        }>;
      };
      for (const prop of oe.properties) {
        if (prop.type === "KeyValueProperty" && prop.value) {
          transformExpression(prop.value, ctx);
        } else if (prop.type === "MethodProperty") {
          transformMethodProperty(prop as unknown as MethodProperty, ctx);
        } else if (prop.type === "GetterProperty") {
          transformGetterProperty(prop as unknown as GetterProperty, ctx);
        } else if (prop.type === "SetterProperty") {
          transformSetterProperty(prop as unknown as SetterProperty, ctx);
        } else if (prop.type === "SpreadElement") {
          const se2 = prop as unknown as { arguments: Expression };
          transformExpression(se2.arguments, ctx);
        }
      }
      break;
    }
    case "TemplateLiteral": {
      const tl = expr as unknown as { expressions: Expression[] };
      for (const e of tl.expressions) {
        transformExpression(e, ctx);
      }
      break;
    }
    case "TaggedTemplateExpression": {
      const tte = expr as unknown as {
        tag: Expression;
        template: { expressions: Expression[] };
      };
      transformExpression(tte.tag, ctx);
      for (const e of tte.template.expressions) {
        transformExpression(e, ctx);
      }
      break;
    }
    case "YieldExpression": {
      const ye = expr as unknown as { argument?: Expression };
      if (ye.argument) transformExpression(ye.argument, ctx);
      break;
    }
    case "ParenthesisExpression": {
      const pe = expr as unknown as { expression: Expression };
      transformExpression(pe.expression, ctx);
      break;
    }
    case "OptionalChainingExpression": {
      const oce = expr as unknown as { base: Expression };
      transformExpression(oce.base, ctx);
      break;
    }
    case "TsAsExpression":
    case "TsSatisfiesExpression":
    case "TsTypeAssertion":
    case "TsConstAssertion":
    case "TsNonNullExpression": {
      const tse = expr as unknown as { expression: Expression };
      transformExpression(tse.expression, ctx);
      break;
    }
    case "TsInstantiation": {
      const ti = expr as unknown as { expression: Expression };
      transformExpression(ti.expression, ctx);
      break;
    }
    default:
      // Identifier, Literal, ThisExpression, MetaProperty, etc. — no children to recurse into
      break;
  }
}

// ---------- function transformers ----------

function getFunctionName(node: {
  type: string;
  identifier?: { value: string };
  key?: { type: string; value?: string };
}): string {
  if (node.identifier && node.identifier.value) return node.identifier.value;
  if (node.key) {
    if (node.key.type === "Identifier" && node.key.value) return node.key.value;
    if (node.key.type === "StringLiteral" && node.key.value)
      return node.key.value;
  }
  return "<anonymous>";
}

function transformFunctionDecl(
  decl: FunctionDeclaration,
  ctx: TransformContext,
): void {
  if (!decl.body) return;

  const definitionStart = spanStartOf(decl.identifier) ?? decl.span.start;
  const resolved = resolveSpan(definitionStart, ctx);
  const name = decl.identifier?.value ?? "<anonymous>";
  const params = extractParamNames(decl.params as unknown[]);
  const fnId = ctx.manifest.addFunction(
    name,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
    params,
  );

  ctx.manifest.addCallSite(
    fnId,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
  );

  instrumentFunctionBody(decl.body, fnId, false, ctx, params);
}

function transformFunctionExpression(
  expr: FunctionExpression,
  ctx: TransformContext,
): void {
  if (!expr.body) return;

  const definitionStart = spanStartOf(expr.identifier) ?? expr.span.start;
  const resolved = resolveSpan(definitionStart, ctx);
  const name = getFunctionName(
    expr as unknown as { type: string; identifier?: { value: string } },
  );
  const params = extractParamNames(expr.params as unknown[]);
  const fnId = ctx.manifest.addFunction(
    name,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
    params,
  );

  ctx.manifest.addCallSite(
    fnId,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
  );

  instrumentFunctionBody(expr.body, fnId, false, ctx, params);
}

function transformArrowFunction(
  expr: ArrowFunctionExpression,
  ctx: TransformContext,
): void {
  const resolved = resolveSpan(expr.span.start, ctx);
  const params = extractParamNames(expr.params as unknown[]);
  const fnId = ctx.manifest.addFunction(
    "<arrow>",
    resolved.pathIndex,
    resolved.line,
    resolved.col,
    params,
  );

  ctx.manifest.addCallSite(
    fnId,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
  );

  if (expr.body.type === "BlockStatement") {
    // Arrow with block body
    instrumentFunctionBody(
      expr.body as BlockStatement,
      fnId,
      false,
      ctx,
      params,
    );
  } else {
    // Arrow with expression body: (x) => expr
    // Transform to: (x) => { __ct.enter(fnId, arguments); __ct.step(siteId); return __ct.ret(fnId, expr); }
    const originalExpr = expr.body as Expression;
    transformExpression(originalExpr, ctx);

    const bodyResolved = resolveSpan(
      (originalExpr as unknown as { span: Span }).span.start,
      ctx,
    );
    const stepSiteId = ctx.manifest.addStepSite(
      bodyResolved.pathIndex,
      bodyResolved.line,
      bodyResolved.col,
    );
    ctx.manifest.addReturnSite(
      fnId,
      bodyResolved.pathIndex,
      bodyResolved.line,
      bodyResolved.col,
    );

    const block = mkBlock([
      mkEnterCall(fnId),
      mkStepCall(stepSiteId),
      mkReturnStmt(mkRetExpr(fnId, originalExpr)) as Statement,
    ]);

    (expr as { body: BlockStatement | Expression }).body = block;
  }
}

function transformMethodProperty(
  prop: MethodProperty,
  ctx: TransformContext,
): void {
  // MethodProperty has Fn fields directly on it
  const fn = prop as unknown as {
    body?: BlockStatement;
    span: Span;
    key?: { type: string; value?: string };
    params?: unknown[];
  };
  if (!fn.body) return;

  const definitionStart = spanStartOf(fn.key) ?? fn.span.start;
  const resolved = resolveSpan(definitionStart, ctx);
  const name = getFunctionName(
    fn as unknown as { type: string; key?: { type: string; value?: string } },
  );
  const params = fn.params ? extractParamNames(fn.params) : [];
  const fnId = ctx.manifest.addFunction(
    name,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
    params,
  );
  ctx.manifest.addCallSite(
    fnId,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
  );
  instrumentFunctionBody(fn.body, fnId, false, ctx, params);
}

function transformGetterProperty(
  prop: GetterProperty,
  ctx: TransformContext,
): void {
  if (!prop.body) return;
  const definitionStart = spanStartOf(prop.key) ?? prop.span.start;
  const resolved = resolveSpan(definitionStart, ctx);
  const keyName = getFunctionName(
    prop as unknown as { type: string; key?: { type: string; value?: string } },
  );
  // Getters have no parameters
  const fnId = ctx.manifest.addFunction(
    `get ${keyName}`,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
  );
  ctx.manifest.addCallSite(
    fnId,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
  );
  instrumentFunctionBody(prop.body, fnId, false, ctx, []);
}

function transformSetterProperty(
  prop: SetterProperty,
  ctx: TransformContext,
): void {
  if (!prop.body) return;
  const definitionStart = spanStartOf(prop.key) ?? prop.span.start;
  const resolved = resolveSpan(definitionStart, ctx);
  const keyName = getFunctionName(
    prop as unknown as { type: string; key?: { type: string; value?: string } },
  );
  // Setters have one parameter from prop.param
  const setterParam = (prop as unknown as { param?: unknown }).param;
  const params = setterParam ? extractParamNames([setterParam]) : [];
  const fnId = ctx.manifest.addFunction(
    `set ${keyName}`,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
    params,
  );
  ctx.manifest.addCallSite(
    fnId,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
  );
  instrumentFunctionBody(prop.body, fnId, false, ctx, params);
}

function transformClassBody(
  cls: { body: Array<{ type: string }> },
  ctx: TransformContext,
): void {
  // Also handle superClass expressions in class declarations/expressions
  const clsAny = cls as unknown as { superClass?: Expression };
  if (clsAny.superClass) {
    transformExpression(clsAny.superClass, ctx);
  }

  for (const member of cls.body) {
    switch (member.type) {
      case "Constructor": {
        const ctor = member as unknown as Constructor;
        transformConstructor(ctor, cls, ctx);
        break;
      }
      case "ClassMethod": {
        const cm = member as unknown as ClassMethod;
        transformClassMethod(cm, ctx);
        break;
      }
      case "PrivateMethod": {
        const pm = member as unknown as PrivateMethod;
        transformClassMethod(pm as unknown as ClassMethod, ctx);
        break;
      }
      case "ClassProperty":
      case "PrivateProperty": {
        const cp = member as unknown as { value?: Expression };
        if (cp.value) transformExpression(cp.value, ctx);
        break;
      }
      case "StaticBlock": {
        const sb = member as unknown as { body: BlockStatement };
        transformBlockBody(sb.body.stmts, ctx);
        break;
      }
      default:
        break;
    }
  }
}

function transformConstructor(
  ctor: Constructor,
  cls: { body: Array<{ type: string }> },
  ctx: TransformContext,
): void {
  if (!ctor.body) return;

  const resolved = resolveSpan(ctor.span.start, ctx);
  const params = extractParamNames(ctor.params as unknown[]);
  const fnId = ctx.manifest.addFunction(
    "constructor",
    resolved.pathIndex,
    resolved.line,
    resolved.col,
    params,
  );
  ctx.manifest.addCallSite(
    fnId,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
  );

  // Check if this is a derived constructor (has superClass)
  const clsAny = cls as unknown as { superClass?: Expression };
  const isDerived = !!clsAny.superClass;

  instrumentFunctionBody(ctor.body, fnId, isDerived, ctx, params);
}

function transformClassMethod(cm: ClassMethod, ctx: TransformContext): void {
  const fn = cm.function;
  if (!fn.body) return;

  const definitionStart = spanStartOf(cm.key) ?? cm.span.start;
  const resolved = resolveSpan(definitionStart, ctx);
  const name = getFunctionName(
    cm as unknown as { type: string; key?: { type: string; value?: string } },
  );
  const params = extractParamNames(fn.params as unknown[]);
  const fnId = ctx.manifest.addFunction(
    name,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
    params,
  );
  ctx.manifest.addCallSite(
    fnId,
    resolved.pathIndex,
    resolved.line,
    resolved.col,
  );

  instrumentFunctionBody(fn.body, fnId, false, ctx, params);
}

// ---------- core function body instrumentation ----------

/**
 * Instrument a function body:
 * 1. Insert __ct.enter(fnId, arguments) after directive prologues
 *    (or after super() for derived constructors)
 * 2. Rewrite return statements to use __ct.ret(fnId, expr)
 * 3. Insert step calls before each executable statement
 * 4. Append implicit __ct.ret(fnId) if no explicit return
 */
/**
 * Helper to add a step site for a statement, resolving through source maps.
 */
function addStepSiteForStmt(stmt: Statement, ctx: TransformContext): number {
  const span = (stmt as unknown as { span: Span }).span;
  const resolved = resolveSpan(span.start, ctx);
  return ctx.manifest.addStepSite(
    resolved.pathIndex,
    resolved.line,
    resolved.col,
  );
}

function instrumentFunctionBody(
  body: BlockStatement,
  fnId: number,
  isDerivedCtor: boolean,
  ctx: TransformContext,
  paramNames?: string[],
): void {
  const stmts = body.stmts;

  // First, recurse into all statements to handle nested functions
  for (const stmt of stmts) {
    transformStatement(stmt, ctx);
  }

  // Rewrite return statements
  rewriteReturns(stmts, fnId, ctx);

  // Now insert step calls before each executable statement
  const withSteps: Statement[] = [];
  const dirCount = directivePrologueCount(stmts);

  // Add directive prologues first (no step before them)
  for (let i = 0; i < dirCount; i++) {
    withSteps.push(stmts[i]);
  }

  // M16a: emit one __ct.write call per named parameter immediately
  // after __ct.enter so the trace records the parameter binding as
  // an explicit `Assignment` event.  The runtime classifies these
  // as `RValue::Compound([])` (the actual values flow through the
  // call args; the db-backend correlates them via the manifest's
  // function signature).
  const emitParamWrites = (): void => {
    if (!paramNames || paramNames.length === 0) return;
    const bodySpan = body.span;
    const resolved = resolveSpan(bodySpan.start, ctx);
    for (const name of paramNames) {
      if (!name || name.startsWith("...") || name.startsWith("_param")) {
        // Skip rest parameters and the synthetic placeholders
        // returned by `extractPatternName` for destructured params;
        // M16b extends this to per-element writes.
        continue;
      }
      const siteId = ctx.manifest.addWriteSite(
        resolved.pathIndex,
        resolved.line,
        resolved.col,
        name,
        "Compound",
      );
      withSteps.push(mkWriteCall(siteId));
    }
  };

  if (isDerivedCtor) {
    // For derived constructors, we need to find the super() call
    // and insert __ct.enter after it
    const superIdx = findSuperCallIndex(stmts);
    if (superIdx >= 0) {
      // Add everything up to and including super(), with steps
      for (let i = dirCount; i <= superIdx; i++) {
        if (isExecutableStatement(stmts[i])) {
          const siteId = addStepSiteForStmt(stmts[i], ctx);
          withSteps.push(mkStepCall(siteId));
        }
        withSteps.push(stmts[i]);
        for (const siteId of collectAssignmentSitesFromStatement(
          stmts[i],
          ctx,
        )) {
          withSteps.push(mkWriteCall(siteId));
        }
      }

      // Insert __ct.enter after super()
      withSteps.push(mkEnterCall(fnId));
      emitParamWrites();

      // Add remaining statements with steps
      for (let i = superIdx + 1; i < stmts.length; i++) {
        if (isExecutableStatement(stmts[i])) {
          const siteId = addStepSiteForStmt(stmts[i], ctx);
          withSteps.push(mkStepCall(siteId));
        }
        withSteps.push(stmts[i]);
        for (const siteId of collectAssignmentSitesFromStatement(
          stmts[i],
          ctx,
        )) {
          withSteps.push(mkWriteCall(siteId));
        }
      }
    } else {
      // No super() found — insert enter at beginning (after directives)
      withSteps.push(mkEnterCall(fnId));
      emitParamWrites();
      for (let i = dirCount; i < stmts.length; i++) {
        if (isExecutableStatement(stmts[i])) {
          const siteId = addStepSiteForStmt(stmts[i], ctx);
          withSteps.push(mkStepCall(siteId));
        }
        withSteps.push(stmts[i]);
        for (const siteId of collectAssignmentSitesFromStatement(
          stmts[i],
          ctx,
        )) {
          withSteps.push(mkWriteCall(siteId));
        }
      }
    }
  } else {
    // Normal function — insert enter after directive prologues
    withSteps.push(mkEnterCall(fnId));
    emitParamWrites();

    for (let i = dirCount; i < stmts.length; i++) {
      if (isExecutableStatement(stmts[i])) {
        const siteId = addStepSiteForStmt(stmts[i], ctx);
        withSteps.push(mkStepCall(siteId));
      }
      withSteps.push(stmts[i]);
      for (const siteId of collectAssignmentSitesFromStatement(stmts[i], ctx)) {
        withSteps.push(mkWriteCall(siteId));
      }
    }
  }

  // Append implicit __ct.ret if no explicit return found
  if (!hasExplicitReturn(stmts)) {
    const bodySpan = body.span;
    const resolved = resolveSpan(bodySpan.end, ctx);
    ctx.manifest.addReturnSite(
      fnId,
      resolved.pathIndex,
      resolved.line,
      resolved.col,
    );
    withSteps.push(mkExprStmt(mkRetExpr(fnId)));
  }

  // Replace body stmts
  body.stmts = withSteps;
}

/**
 * Rewrite return statements in a statement list (non-recursive into nested functions).
 */
function rewriteReturns(
  stmts: Statement[],
  fnId: number,
  ctx: TransformContext,
): void {
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (stmt.type === "ReturnStatement") {
      const ret = stmt as unknown as ReturnStatement & { span: Span };
      const resolved = resolveSpan(ret.span.start, ctx);
      ctx.manifest.addReturnSite(
        fnId,
        resolved.pathIndex,
        resolved.line,
        resolved.col,
      );

      if (ret.argument) {
        ret.argument = mkRetExpr(fnId, ret.argument);
      } else {
        ret.argument = mkRetExpr(fnId);
      }
    } else {
      // Recurse into blocks but NOT into nested functions
      rewriteReturnsInStatement(stmt, fnId, ctx);
    }
  }
}

/**
 * Recursively find and rewrite returns in a statement,
 * but do NOT descend into nested function/arrow bodies.
 */
function rewriteReturnsInStatement(
  stmt: Statement,
  fnId: number,
  ctx: TransformContext,
): void {
  switch (stmt.type) {
    case "BlockStatement": {
      const bs = stmt as BlockStatement;
      rewriteReturns(bs.stmts, fnId, ctx);
      break;
    }
    case "IfStatement": {
      const is = stmt as unknown as {
        consequent: Statement;
        alternate?: Statement;
      };
      rewriteReturnsInStatement(is.consequent, fnId, ctx);
      if (is.alternate) rewriteReturnsInStatement(is.alternate, fnId, ctx);
      break;
    }
    case "WhileStatement":
    case "DoWhileStatement":
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement": {
      const loop = stmt as unknown as { body: Statement };
      rewriteReturnsInStatement(loop.body, fnId, ctx);
      break;
    }
    case "SwitchStatement": {
      const sw = stmt as unknown as {
        cases: Array<{ consequent: Statement[] }>;
      };
      for (const c of sw.cases) {
        rewriteReturns(c.consequent, fnId, ctx);
      }
      break;
    }
    case "TryStatement": {
      const ts = stmt as unknown as {
        block: BlockStatement;
        handler?: { body: BlockStatement };
        finalizer?: BlockStatement;
      };
      rewriteReturns(ts.block.stmts, fnId, ctx);
      if (ts.handler) rewriteReturns(ts.handler.body.stmts, fnId, ctx);
      if (ts.finalizer) rewriteReturns(ts.finalizer.stmts, fnId, ctx);
      break;
    }
    case "LabeledStatement": {
      const ls = stmt as unknown as { body: Statement };
      rewriteReturnsInStatement(ls.body, fnId, ctx);
      break;
    }
    case "WithStatement": {
      const ws = stmt as unknown as { body: Statement };
      rewriteReturnsInStatement(ws.body, fnId, ctx);
      break;
    }
    default:
      break;
  }
}
