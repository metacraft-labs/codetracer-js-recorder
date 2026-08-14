/**
 * Static scope analysis for per-step local-variable capture.
 *
 * ## Why this exists
 *
 * Until M37 the JS recorder only ever produced a `Value` event for a
 * binding at the exact point it was written — function entry for
 * parameters (`__ct.enter`) and the assignment site for `var`/`let`/
 * `const` (`__ct.write`, the M16a write-site pass).  That is enough to
 * reconstruct a *history* of a variable, but it is not enough to answer
 * the question the State panel asks: **"what is in scope, and what does
 * it hold, at this step?"**  Stopping on `return scaled;` produced an
 * empty state view because no event landed on that step.
 *
 * The Ruby and Python recorders emit the complete visible local set on
 * *every* step, which makes the trace point-in-time queryable without
 * the reader having to replay the whole frame.  This module computes the
 * same thing for JavaScript statically, at instrumentation time, so the
 * runtime cost is a plain array literal of live bindings rather than a
 * scope-chain reflection API (which JS does not offer outside the
 * debugger protocol).
 *
 * ## What it computes
 *
 * For every AST node that the visitor will mint a *step site* for, the
 * analysis records the list of binding names that are
 *
 *   1. declared in the **innermost function frame** (parameters plus
 *      `var` / `let` / `const`, including destructured binders, loop
 *      binders and `catch` params), and
 *   2. **textually before** that step site, so a `let`/`const` is never
 *      referenced inside its temporal dead zone, and
 *   3. still in a live block scope (`let`/`const` disappear when their
 *      block ends; `var` is hoisted to the function scope and stays).
 *
 * ## What it deliberately excludes
 *
 * * **Enclosing function frames.**  A step inside a nested function
 *   reports only that function's own locals.  This matches the frame
 *   model the State panel presents (Ruby's `local_variables`, Python's
 *   `frame.f_locals`), and it sidesteps a real hazard: a closure can be
 *   *called* before an outer `let` it captures has initialised, so
 *   naming outer bindings could throw a `ReferenceError` from inside
 *   instrumentation.  Recording must never change program behaviour.
 *
 * * **Function and class declarations.**  Both are hoisted bindings
 *   whose values are of little debugging interest, and a class binding
 *   has a TDZ of its own.  Excluding them keeps the per-step payload
 *   proportional to the data the program is actually working with.
 *
 * * **`arguments`**, which `__ct.enter` already records as call args.
 *
 * The result is keyed by AST node identity, so the visitor can look up
 * the set for a statement at the moment it mints that statement's step
 * site without re-deriving any scope information.
 */

import type { Module, BlockStatement } from "@swc/types";

/** Loosely-typed AST node — the SWC JSON AST is walked structurally. */
type Node = Record<string, unknown> & { type: string };

/**
 * Map from an AST node that receives a step site to the ordered list of
 * local binding names visible immediately *before* that node executes.
 *
 * Keys are the original AST nodes, so lookups are identity-based and
 * unaffected by the statement rewriting the visitor performs afterwards.
 */
export type StepLocalsMap = Map<object, string[]>;

/**
 * A single function frame's scope chain.
 *
 * `blocks[0]` is the function scope itself (parameters and hoisted
 * `var`s); every nested block pushes another entry.  Lookups flatten the
 * stack outermost-first, so the visible list reads
 * "parameters, then locals in declaration order" — a stable order the
 * trace's per-step value list can rely on.
 */
class FrameScope {
  private readonly blocks: string[][] = [[]];

  /** Enter a nested block scope (`{ … }`, loop head, `catch`, `switch`). */
  pushBlock(): void {
    this.blocks.push([]);
  }

  /** Leave the innermost block scope, dropping its `let`/`const` binders. */
  popBlock(): void {
    // Never pop the function scope itself — an unbalanced pop would
    // silently leak bindings between sibling blocks.
    if (this.blocks.length > 1) this.blocks.pop();
  }

  /**
   * Declare a block-scoped binding (`let`, `const`, `catch` param, loop
   * binder) in the innermost block.
   */
  declareLexical(name: string): void {
    this.declareIn(this.blocks.length - 1, name);
  }

  /**
   * Declare a function-scoped binding (`var`, parameter).
   *
   * `var` is hoisted to the enclosing function, so it must stay visible
   * after the block it was written in has ended — recording it in
   * `blocks[0]` is what makes `var x` declared inside an `if` still show
   * up on the function's `return` line.
   */
  declareVar(name: string): void {
    this.declareIn(0, name);
  }

  private declareIn(blockIndex: number, name: string): void {
    if (!isRecordableBindingName(name)) return;
    const block = this.blocks[blockIndex];
    if (!block) return;
    if (block.indexOf(name) !== -1) return;
    block.push(name);
  }

  /**
   * The visible binding names, outermost scope first, de-duplicated.
   *
   * A shadowed name appears once: the identifier the instrumenter emits
   * resolves through the ordinary JS scope chain, so it reads the
   * innermost binding — exactly what the debugger should show.
   */
  visible(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const block of this.blocks) {
      for (const name of block) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }
}

/**
 * Reject names that must never be emitted into a synthetic value array.
 *
 * `arguments` is already captured by `__ct.enter`; re-reading it would
 * materialise the array a second time on every step for no new
 * information.  Anything that is not a plain identifier (the `...rest`
 * spelling `extractPatternName` produces, or an empty name from a
 * pattern shape we do not decompose) is dropped rather than emitted as
 * invalid syntax.
 */
function isRecordableBindingName(name: string): boolean {
  if (!name) return false;
  if (name === "arguments") return false;
  // Conservative identifier check: the analysis only ever sees names
  // that SWC already parsed as identifiers, so this is a guard against
  // synthetic placeholders leaking in (`_param0`, `...rest`).
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/**
 * Collect the real identifier names bound by a binding pattern.
 *
 * Unlike `extractPatternName` in the visitor — which produces display
 * names for the *manifest's* parameter list and falls back to
 * `_param<N>` placeholders — this walks destructuring patterns to their
 * leaves, because those leaves are the names that actually exist as live
 * bindings in the function body.  `function f({ a, b: [c] })` binds
 * `a`, `b` is not bound, and `c` is.
 */
export function collectBindingNames(
  pat: unknown,
  out: string[] = [],
): string[] {
  if (!pat || typeof pat !== "object") return out;
  const p = pat as Node;

  switch (p.type) {
    case "Identifier": {
      const value = p.value;
      if (typeof value === "string") out.push(value);
      return out;
    }
    // SWC wraps function parameters; unwrap to the pattern.
    case "Parameter":
      return collectBindingNames(p.pat, out);
    case "TsParameterProperty":
      return collectBindingNames(p.param, out);
    case "AssignmentPattern":
      return collectBindingNames(p.left, out);
    case "RestElement":
      return collectBindingNames(p.argument, out);
    case "ObjectPattern": {
      const props = (p.properties as Node[] | undefined) ?? [];
      for (const prop of props) {
        switch (prop.type) {
          case "AssignmentPatternProperty": {
            // Shorthand `{ a }` / `{ a = 1 }` — the key IS the binding.
            const key = prop.key as Node | undefined;
            if (key && typeof key.value === "string") out.push(key.value);
            break;
          }
          case "KeyValuePatternProperty":
            // `{ a: x }` / `{ [k]: x }` — the VALUE is the binding.
            collectBindingNames(prop.value, out);
            break;
          case "RestElement":
            collectBindingNames(prop.argument, out);
            break;
          default:
            break;
        }
      }
      return out;
    }
    case "ArrayPattern": {
      const elements = (p.elements as unknown[] | undefined) ?? [];
      for (const el of elements) {
        // Array holes (`const [, b] = xs`) are null entries.
        if (el) collectBindingNames(el, out);
      }
      return out;
    }
    default:
      return out;
  }
}

/** True for a statement that is a directive prologue (`"use strict"`). */
function isDirective(stmt: unknown): boolean {
  if (!stmt || typeof stmt !== "object") return false;
  const s = stmt as Node;
  if (s.type !== "ExpressionStatement") return false;
  const expr = s.expression as Node | undefined;
  return expr?.type === "StringLiteral";
}

/** Number of leading directive prologue statements in a body. */
export function countDirectives(stmts: unknown[]): number {
  let count = 0;
  for (const s of stmts) {
    if (isDirective(s)) count++;
    else break;
  }
  return count;
}

/**
 * Compute the per-step-site visible-locals map for a parsed module.
 *
 * The traversal mirrors the visitor's, statement for statement, so every
 * node the visitor mints a step site for has an entry here.  Nodes with
 * no visible locals are recorded with an empty array rather than left
 * absent, which lets the visitor distinguish "analysed, nothing to
 * capture" from "not analysed" (the latter can happen for AST shapes
 * added to the visitor but not here, and must degrade to the pre-M37
 * behaviour rather than to a wrong capture).
 */
export function computeStepLocals(module: Module): StepLocalsMap {
  const map: StepLocalsMap = new Map();
  const frame = new FrameScope();

  // The module body is its own frame: the `<module>` function the
  // instrumenter synthesises. Top-level `var`/`let`/`const` therefore
  // show up in the module frame's state view.
  const body = (module as unknown as { body: unknown[] }).body ?? [];
  const dirCount = countDirectives(body);
  for (let i = dirCount; i < body.length; i++) {
    walkModuleItem(body[i], frame, map);
  }

  return map;
}

/** Record the visible set for a node that will receive a step site. */
function record(node: unknown, frame: FrameScope, map: StepLocalsMap): void {
  if (!node || typeof node !== "object") return;
  map.set(node as object, frame.visible());
}

/**
 * Walk a top-level module item.
 *
 * Import/export *declarations* are not executable and receive no step
 * site (see `isExecutableModuleItem` in the visitor), but an
 * `export const x = …` does bind `x` in the module scope and its
 * initialiser can contain nested functions, so the declaration is still
 * walked for its bindings.
 */
function walkModuleItem(
  item: unknown,
  frame: FrameScope,
  map: StepLocalsMap,
): void {
  if (!item || typeof item !== "object") return;
  const node = item as Node;

  switch (node.type) {
    case "ImportDeclaration":
    case "TsInterfaceDeclaration":
    case "TsTypeAliasDeclaration":
    case "TsModuleDeclaration":
    case "TsImportEqualsDeclaration":
    case "TsNamespaceExportDeclaration":
    case "ExportAllDeclaration":
    case "ExportNamedDeclaration":
      return;
    case "ExportDeclaration":
      // `export const x = 1;` / `export function f() {}` — no step site
      // for the wrapper, but the inner declaration still binds.
      walkStatement(node.declaration, frame, map);
      return;
    case "ExportDefaultDeclaration": {
      const decl = node.decl as Node | undefined;
      if (decl?.type === "FunctionExpression") walkFunctionLike(decl, map);
      else if (decl?.type === "ClassExpression") walkClassBody(decl, map);
      return;
    }
    case "ExportDefaultExpression":
      walkExpression(node.expression, map);
      return;
    default:
      record(item, frame, map);
      walkStatement(item, frame, map);
      return;
  }
}

/**
 * Walk a statement: recurse into its sub-expressions and blocks, then
 * add whatever bindings it introduces.
 *
 * Bindings are added *after* the recursion so a declaration is never
 * visible at its own step site — that is what keeps `let`/`const` out of
 * their temporal dead zone.
 */
function walkStatement(
  stmt: unknown,
  frame: FrameScope,
  map: StepLocalsMap,
): void {
  if (!stmt || typeof stmt !== "object") return;
  const node = stmt as Node;

  switch (node.type) {
    case "VariableDeclaration": {
      const decls = (node.declarations as Node[] | undefined) ?? [];
      // Initialisers first: a nested function in an initialiser gets its
      // own frame, and the binder must not be visible inside its own RHS.
      for (const decl of decls) {
        if (decl.init) walkExpression(decl.init, map);
      }
      declareVariableDeclaration(node, frame);
      return;
    }

    case "FunctionDeclaration":
      // Hoisted binding, deliberately not recorded as a local (see the
      // module docstring); still walked so its body is analysed.
      walkFunctionLike(node, map);
      return;

    case "ClassDeclaration":
      walkClassBody(node, map);
      return;

    case "ExpressionStatement":
      walkExpression(node.expression, map);
      return;

    case "IfStatement": {
      walkExpression(node.test, map);
      walkBranch(node.consequent, frame, map);
      const alternate = node.alternate as Node | undefined;
      if (alternate) {
        // `else if` is not wrapped in a block by the visitor, so it gets
        // no step site of its own — walk it as a bare statement.
        if (alternate.type === "IfStatement") {
          walkStatement(alternate, frame, map);
        } else {
          walkBranch(alternate, frame, map);
        }
      }
      return;
    }

    case "WhileStatement":
    case "DoWhileStatement":
      walkExpression(node.test, map);
      walkBranch(node.body, frame, map);
      return;

    case "ForStatement": {
      // The loop head's `let`/`const` binder scopes over the body only.
      frame.pushBlock();
      const init = node.init as Node | undefined;
      if (init) {
        if (init.type === "VariableDeclaration") {
          const decls = (init.declarations as Node[] | undefined) ?? [];
          for (const decl of decls) {
            if (decl.init) walkExpression(decl.init, map);
          }
          declareVariableDeclaration(init, frame);
        } else {
          walkExpression(init, map);
        }
      }
      if (node.test) walkExpression(node.test, map);
      if (node.update) walkExpression(node.update, map);
      walkBranch(node.body, frame, map);
      frame.popBlock();
      return;
    }

    case "ForInStatement":
    case "ForOfStatement": {
      frame.pushBlock();
      walkExpression(node.right, map);
      const left = node.left as Node | undefined;
      if (left?.type === "VariableDeclaration") {
        declareVariableDeclaration(left, frame);
      }
      walkBranch(node.body, frame, map);
      frame.popBlock();
      return;
    }

    case "SwitchStatement": {
      walkExpression(node.discriminant, map);
      // The whole switch body is one block scope in JS — a `let` in one
      // case is visible (in TDZ) in the following cases.
      frame.pushBlock();
      const cases = (node.cases as Node[] | undefined) ?? [];
      for (const c of cases) {
        if (c.test) walkExpression(c.test, map);
        const consequent = (c.consequent as unknown[] | undefined) ?? [];
        for (const s of consequent) {
          record(s, frame, map);
          walkStatement(s, frame, map);
        }
      }
      frame.popBlock();
      return;
    }

    case "TryStatement": {
      walkBlockStatements(node.block, frame, map);
      const handler = node.handler as Node | undefined;
      if (handler) {
        frame.pushBlock();
        if (handler.param) {
          for (const name of collectBindingNames(handler.param)) {
            frame.declareLexical(name);
          }
        }
        walkBlockStatements(handler.body, frame, map, /* ownScope */ false);
        frame.popBlock();
      }
      if (node.finalizer) walkBlockStatements(node.finalizer, frame, map);
      return;
    }

    case "ThrowStatement":
      walkExpression(node.argument, map);
      return;

    case "ReturnStatement":
      if (node.argument) walkExpression(node.argument, map);
      return;

    case "LabeledStatement":
      // The label wrapper gets the step site (minted by the enclosing
      // block); its body does not get one of its own.
      walkStatement(node.body, frame, map);
      return;

    case "BlockStatement":
      walkBlockStatements(node, frame, map);
      return;

    case "WithStatement":
      walkExpression(node.object, map);
      walkBranch(node.body, frame, map);
      return;

    default:
      return;
  }
}

/**
 * Add the binders of a `var`/`let`/`const` declaration to the frame.
 *
 * `var` goes to the function scope, `let`/`const` to the innermost
 * block — the distinction is what makes a `var` written inside an `if`
 * still visible on the function's `return` line while a `let` is not.
 */
function declareVariableDeclaration(node: Node, frame: FrameScope): void {
  const isVar = node.kind === "var";
  const decls = (node.declarations as Node[] | undefined) ?? [];
  for (const decl of decls) {
    for (const name of collectBindingNames(decl.id)) {
      if (isVar) frame.declareVar(name);
      else frame.declareLexical(name);
    }
  }
}

/**
 * Walk a branch body (`if`/loop/`with` body).
 *
 * The visitor wraps a single-statement body in a synthetic block before
 * instrumenting it, so a bare statement receives a step site exactly as
 * a block's contents would.  The wrapping preserves the original
 * statement node, which is what the map is keyed on.
 */
function walkBranch(
  body: unknown,
  frame: FrameScope,
  map: StepLocalsMap,
): void {
  if (!body || typeof body !== "object") return;
  const node = body as Node;
  if (node.type === "BlockStatement") {
    walkBlockStatements(node, frame, map);
    return;
  }
  frame.pushBlock();
  record(node, frame, map);
  walkStatement(node, frame, map);
  frame.popBlock();
}

/**
 * Walk the statements of a block, minting a step-site entry for each.
 *
 * `ownScope` is false when the caller has already pushed the block scope
 * because it needed to seed it first (the `catch` binding).
 */
function walkBlockStatements(
  block: unknown,
  frame: FrameScope,
  map: StepLocalsMap,
  ownScope: boolean = true,
): void {
  if (!block || typeof block !== "object") return;
  const stmts = ((block as Node).stmts as unknown[] | undefined) ?? [];
  if (ownScope) frame.pushBlock();
  for (const stmt of stmts) {
    record(stmt, frame, map);
    walkStatement(stmt, frame, map);
  }
  if (ownScope) frame.popBlock();
}

/**
 * Analyse a function-like node (declaration, expression, arrow, method,
 * accessor, constructor) as a fresh frame.
 *
 * A new `FrameScope` is created rather than nesting into the caller's,
 * which is what implements the "own locals only" rule described in the
 * module docstring.
 */
function walkFunctionLike(node: Node, map: StepLocalsMap): void {
  const frame = new FrameScope();

  const params = (node.params as unknown[] | undefined) ?? [];
  for (const param of params) {
    for (const name of collectBindingNames(param)) {
      frame.declareVar(name);
    }
  }

  const body = node.body as Node | undefined;
  if (!body) return;

  if (body.type === "BlockStatement") {
    walkFunctionBody(body, frame, map);
    return;
  }

  // Concise arrow body: `(x) => expr`.  The visitor rewrites it into a
  // block containing a single step site keyed on the body expression.
  record(body, frame, map);
  walkExpression(body, map);
}

/**
 * Walk a function body.
 *
 * The function scope *is* the body's block scope — `instrumentFunctionBody`
 * does not introduce another level — so no extra block is pushed here.
 * Directive prologues receive no step site.
 */
function walkFunctionBody(
  body: Node,
  frame: FrameScope,
  map: StepLocalsMap,
): void {
  const stmts = (body.stmts as unknown[] | undefined) ?? [];
  const dirCount = countDirectives(stmts);
  for (let i = dirCount; i < stmts.length; i++) {
    record(stmts[i], frame, map);
    walkStatement(stmts[i], frame, map);
  }
}

/** Analyse every function-valued member of a class body. */
function walkClassBody(node: Node, map: StepLocalsMap): void {
  const superClass = node.superClass as Node | undefined;
  if (superClass) walkExpression(superClass, map);

  const members = (node.body as Node[] | undefined) ?? [];
  for (const member of members) {
    switch (member.type) {
      case "Constructor":
        walkFunctionLike(member, map);
        break;
      case "ClassMethod":
      case "PrivateMethod":
        walkFunctionLike(member.function as Node, map);
        break;
      case "ClassProperty":
      case "PrivateProperty":
        if (member.value) walkExpression(member.value, map);
        break;
      case "StaticBlock": {
        // A static block is its own frame with no parameters.
        const frame = new FrameScope();
        walkFunctionBody(member.body as Node, frame, map);
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Descend through an expression looking for nested function-like nodes.
 *
 * Mirrors `transformExpression` in the visitor: only shapes that can
 * *contain* a function body need traversing, because a frame's locals
 * never depend on the expression it appears in.
 */
function walkExpression(expr: unknown, map: StepLocalsMap): void {
  if (!expr || typeof expr !== "object") return;
  const node = expr as Node;

  switch (node.type) {
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      walkFunctionLike(node, map);
      return;

    case "ClassExpression":
      walkClassBody(node, map);
      return;

    case "CallExpression":
    case "NewExpression": {
      const callee = node.callee as Node | undefined;
      if (callee && callee.type !== "Super" && callee.type !== "Import") {
        walkExpression(callee, map);
      }
      const args = (node.arguments as Node[] | undefined) ?? [];
      for (const arg of args) walkExpression(arg.expression, map);
      return;
    }

    case "MemberExpression":
    case "SuperPropExpression":
      walkExpression(node.object, map);
      return;

    case "AssignmentExpression":
      walkExpression(node.right, map);
      return;

    case "BinaryExpression":
      walkExpression(node.left, map);
      walkExpression(node.right, map);
      return;

    case "ConditionalExpression":
      walkExpression(node.test, map);
      walkExpression(node.consequent, map);
      walkExpression(node.alternate, map);
      return;

    case "UnaryExpression":
    case "UpdateExpression":
    case "AwaitExpression":
      walkExpression(node.argument, map);
      return;

    case "YieldExpression":
      if (node.argument) walkExpression(node.argument, map);
      return;

    case "SequenceExpression": {
      const exprs = (node.expressions as unknown[] | undefined) ?? [];
      for (const e of exprs) walkExpression(e, map);
      return;
    }

    case "ArrayExpression": {
      const elements = (node.elements as Node[] | undefined) ?? [];
      for (const el of elements) {
        if (el && el.expression) walkExpression(el.expression, map);
      }
      return;
    }

    case "ObjectExpression": {
      const props = (node.properties as Node[] | undefined) ?? [];
      for (const prop of props) {
        switch (prop.type) {
          case "KeyValueProperty":
            if (prop.value) walkExpression(prop.value, map);
            break;
          case "MethodProperty":
          case "GetterProperty":
          case "SetterProperty":
            walkAccessorLike(prop, map);
            break;
          case "SpreadElement":
            walkExpression(prop.arguments, map);
            break;
          default:
            break;
        }
      }
      return;
    }

    case "TemplateLiteral": {
      const exprs = (node.expressions as unknown[] | undefined) ?? [];
      for (const e of exprs) walkExpression(e, map);
      return;
    }

    case "TaggedTemplateExpression": {
      walkExpression(node.tag, map);
      const template = node.template as Node | undefined;
      const exprs = (template?.expressions as unknown[] | undefined) ?? [];
      for (const e of exprs) walkExpression(e, map);
      return;
    }

    case "ParenthesisExpression":
    case "TsAsExpression":
    case "TsSatisfiesExpression":
    case "TsTypeAssertion":
    case "TsConstAssertion":
    case "TsNonNullExpression":
    case "TsInstantiation":
      walkExpression(node.expression, map);
      return;

    case "OptionalChainingExpression":
      walkExpression(node.base, map);
      return;

    default:
      return;
  }
}

/**
 * Analyse an object-literal method / getter / setter.
 *
 * These carry their parameters differently from a plain function node —
 * a setter's single parameter lives on `param`, and a getter has none —
 * so the parameter list is normalised before delegating.
 */
function walkAccessorLike(node: Node, map: StepLocalsMap): void {
  if (node.type === "SetterProperty") {
    const frame = new FrameScope();
    if (node.param) {
      for (const name of collectBindingNames(node.param))
        frame.declareVar(name);
    }
    const body = node.body as Node | undefined;
    if (body) walkFunctionBody(body, frame, map);
    return;
  }
  walkFunctionLike(node, map);
}

/**
 * Test-facing helper: analyse a block statement standalone.
 *
 * Exported so the scope rules can be unit-tested without going through
 * the full instrument → record → decode pipeline.
 */
export function computeStepLocalsForBlock(
  body: BlockStatement,
  params: unknown[] = [],
): StepLocalsMap {
  const map: StepLocalsMap = new Map();
  const frame = new FrameScope();
  for (const param of params) {
    for (const name of collectBindingNames(param)) frame.declareVar(name);
  }
  walkFunctionBody(body as unknown as Node, frame, map);
  return map;
}
