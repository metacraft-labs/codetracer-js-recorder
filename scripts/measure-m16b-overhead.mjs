/**
 * Measure the M16b recorder-side instrumentation overhead and AST
 * expansion factor for the documented shapes.
 *
 * Output is plain-text key/value pairs the docs page consumes via
 * copy/paste; the figures are recomputed by running:
 *
 *   node scripts/measure-m16b-overhead.mjs
 *
 * The script is intentionally dependency-free at the npm-workspace
 * level — it reads the built instrumenter from `dist/`.
 */

import { instrument } from "../packages/instrumenter/dist/index.js";

function measure(label, code) {
  const before = code.length;
  const result = instrument(code, { filename: "bench.js" });
  const after = result.code.length;
  const writeSites = result.manifestSlice.sites.filter(
    (s) => s.kind === "write",
  );
  const stepSites = result.manifestSlice.sites.filter((s) => s.kind === "step");
  return {
    label,
    before,
    after,
    expansion: (after / before).toFixed(2),
    writeSites: writeSites.length,
    stepSites: stepSites.length,
  };
}

const FIXTURES = [
  {
    label: "M16a baseline (simple assignment chain)",
    code: `
const a = 10;
const b = a;
const c = b;
const d = c + 1;
const e = d * 2;
`.repeat(50),
  },
  {
    label: "M16b object destructuring",
    code: `
const obj = { a: 1, b: 2, c: 3, d: 4 };
const { a, b, c, d } = obj;
`.repeat(50),
  },
  {
    label: "M16b array destructuring",
    code: `
const arr = [1, 2, 3, 4, 5];
const [a, b, c, d, e] = arr;
`.repeat(50),
  },
  {
    label: "M16b rest / spread",
    code: `
const arr = [1, 2, 3, 4, 5];
const [head, ...tail] = arr;
`.repeat(50),
  },
  {
    label: "M16b optional chaining",
    code: `
const obj = { field: 1 };
const x = obj?.field;
const y = obj?.missing;
`.repeat(50),
  },
  {
    label: "M16b nullish coalescing",
    code: `
const a = 1;
const b = a ?? 10;
`.repeat(50),
  },
];

for (const f of FIXTURES) {
  const r = measure(f.label, f.code);
  console.log(`[${r.label}]`);
  console.log(`  source bytes:       ${r.before}`);
  console.log(`  instrumented bytes: ${r.after}`);
  console.log(`  expansion factor:   ×${r.expansion}`);
  console.log(`  write sites:        ${r.writeSites}`);
  console.log(`  step sites:         ${r.stepSites}`);
  console.log();
}

// Per-element AST expansion: each recognised write site emits a
// single extra ExpressionStatement (`__ct.write(N);`).  We measure
// the wall-clock cost of the runtime `write` call by stubbing it.
const ITERS = 1_000_000;
function bench(fn, label) {
  // Warm-up
  for (let i = 0; i < 10_000; i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITERS; i++) fn(i);
  const t1 = process.hrtime.bigint();
  const nsTotal = Number(t1 - t0);
  console.log(
    `[${label}] ${(nsTotal / ITERS).toFixed(2)} ns/call (n=${ITERS})`,
  );
}

import { createRuntime } from "../packages/runtime/dist/index.js";
const rt = createRuntime({ skipProcessHooks: true });
bench(() => rt.write(0), "runtime.write(siteId)");
bench(() => rt.step(0), "runtime.step(siteId)  (M16a baseline)");
