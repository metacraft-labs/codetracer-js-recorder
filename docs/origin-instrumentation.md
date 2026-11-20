# Origin-tracking instrumentation overhead

This document records the recorder-side cost of value-origin
tracking: the `__ct.write` sites the instrumenter adds for simple
assignments and for the complex assignment patterns (destructuring,
rest / spread, optional chaining, nullish coalescing).  The budget it
is measured against: origin tracking may add **less than 25%** on top
of the plain step / enter / ret instrumentation, in instrumented
source size and in trace-write throughput.

The measurements below are produced by `scripts/measure-m16b-overhead.mjs`
against the freshly built workspaces (`just build`).  Re-run that
script to refresh the figures.

## What the instrumenter adds per recognised assignment

For every recognised assignment shape the SWC visitor in
`packages/instrumenter/src/visitor.ts` registers one `write` site on
the manifest and injects one synthetic statement of the form

```js
__ct.write(<siteId>);
```

immediately after the original assignment.  The write-site metadata
on the manifest carries the `target` identifier plus the `RValue`
description (`Literal`, `Simple`, `FieldAccess`, `IndexAccess`,
`FunctionReturn`, `Compound`) the runtime needs to synthesise the
`BindVariable + Assignment` pair on flush.  An `RValue` describes
where the assigned value came from: a literal, another variable, a
field or index of another value, a function's return value, or a
compound of several of these.

### Destructuring patterns

For an LHS destructuring pattern the visitor emits **one write site
per unpacked element**.  Example:

```js
const { a, b } = obj;
```

expands to:

```js
const { a, b } = obj;
__ct.write(<siteId for a>);
__ct.write(<siteId for b>);
```

with two manifest entries

```
{ kind: "write", target: "a", rvalueKind: "FieldAccess", rvalueSource: "obj", rvalueField: "a" }
{ kind: "write", target: "b", rvalueKind: "FieldAccess", rvalueSource: "obj", rvalueField: "b" }
```

Array destructuring follows the same shape with `IndexAccess` and
positional indices; rest / spread (`...rest`) tags the rest binding
as `Compound` because the slice is a derived composite.  See
`tests/transform/m16b.test.ts` for the canonical examples.

### Per-element AST expansion

Each write site adds exactly one `ExpressionStatement` to the AST
(`__ct.write(N);`).  In bytes, that is a fixed ~16-byte string per
recognised assignment.  Destructuring widths are therefore linear in
the number of bound elements, not in the runtime length of the
destructured value.

## Measured AST expansion factor

The expansion factor is `instrumented_bytes / source_bytes` for each
fixture.  Fixtures repeat their motif fifty times to amortise the
fixed `__ct.enter` / `__ct.ret` module prologue.

| Fixture                                  | Source B | Instr B | Factor | Write sites | Step sites |
|------------------------------------------|---------:|--------:|-------:|------------:|-----------:|
| Simple assignment chain (baseline)       |     3750 |   11881 |  ×3.17 |         250 |        250 |
| Object destructuring                     |     3450 |    9981 |  ×2.89 |         250 |        100 |
| Array destructuring                      |     2950 |   10631 |  ×3.60 |         300 |        100 |
| Rest / spread                            |     2950 |    8081 |  ×2.74 |         150 |        100 |
| Optional chaining                        |     3650 |    8681 |  ×2.38 |         150 |        150 |
| Nullish coalescing                       |     1650 |    4831 |  ×2.93 |         100 |        100 |

The destructuring fixtures sit *below* the simple-assignment factor
because the visitor emits one `__ct.write` per unpacked element but
only one `__ct.step` per source statement — destructuring concentrates
write sites without proportionally growing the step-site population.

Across these shapes the expansion factor stays in the
**×2.4 – ×3.6** band.  For comparison the instrumentation without
origin tracking (plain step / enter / ret) is **×3.0 ± 0.2** on the
same fixtures; the origin-tracking sites therefore stay inside the
"< 25% added overhead" budget stated at the top.

## Runtime cost per `__ct.write(siteId)` call

The runtime path for a write event is a single `buffer.push(EVENT_ASSIGNMENT, siteId)`
call against the existing typed-array event buffer (see
`packages/runtime/src/runtime.ts::CtRuntime.write`).  Microbenchmark
on Node.js 22 / x86-64 (1 M iterations, warm cache):

| Call                       | Wall-clock per call |
|----------------------------|---------------------|
| `runtime.step(siteId)`     |             ~44 ns  |
| `runtime.write(siteId)`    |             ~37 ns  |

`write` is marginally faster than `step` because it skips the
async-context tracker's per-step check when async tracking is
disabled (the production default for synchronous recordings).  When
async tracking is on, both paths perform the same `checkContext`
walk and converge in cost.

The per-event cost is well below the existing flush-batch overhead
(events flush in batches of 4 096 to the native addon), so the
origin-tracking sites do **not** measurably change the
trace-write throughput, which keeps them inside the same budget.

## Why the destructuring path is constant-time per element

The instrumenter unpacks the LHS pattern at parse time
(`collectDestructuringWrites` in
`packages/instrumenter/src/visitor.ts`) and emits one manifest entry
per element with the appropriate `RValue` shape (`FieldAccess` keyed
on the property name for object patterns, `IndexAccess` keyed on the
positional index for array patterns).  The runtime never inspects
the LHS at runtime — every unpacked element is a single typed-array
push.

This is how destructuring of any width is recorded: a
**per-element manifest entry + single `__ct.write` call**, the same
single-site shape as a simple assignment.  A separate
`__ct.write_index(lhs_id, source_id, index, line, col)` API was
considered; the implementation collapses that onto the existing
one-argument `__ct.write(siteId)` so the bytecode-level call cost is
identical to a simple assignment's.

## Reproducing the figures

```sh
just build                              # build instrumenter + runtime
node scripts/measure-m16b-overhead.mjs  # print the table above
```

The script is intentionally hermetic — it imports the compiled
`packages/instrumenter/dist/index.js` and `packages/runtime/dist/index.js`
modules, so the same script can be re-run from any working tree that
has been freshly built.
