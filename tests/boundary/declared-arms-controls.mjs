/** Compiled declaration falsifiers. Run after `just build`; no Git/network needed.
 * Each phase uses its own package graph. `--root DIR --phase NAME:build|test`
 * permits externally admitted serial execution; default runs the complete matrix.
 * Receipts are evidence, never a reason to skip a phase.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveControlOutputRoot } from "./declared-arms-output-root.mjs";

const source = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixture = path.join(source, "tests/boundary/declared-arms-fixtures");
const manifest = JSON.parse(
  fs.readFileSync(path.join(fixture, "controls.json")),
);
const declaration = "packages/boundary-shim/src/browser/declarations.ts";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = fs.readFileSync(path.join(source, declaration));
const custodyFiles = [
  declaration,
  "Justfile",
  "tests/boundary/declarations.test.ts",
  "tests/boundary/declared-arms-controls.mjs",
  "tests/boundary/declared-arms-output-root.mjs",
  "tests/boundary/declared-arms-output-root.test.ts",
  "tests/boundary/declared-arms-fixtures/controls.json",
  "tests/boundary/declared-arms-fixtures/origin.json",
  "tests/boundary/declared-arms-fixtures/declarations-406.ts.txt",
  "package-lock.json",
  "crates/recorder_native/Cargo.lock",
  "flake.nix",
  "flake.lock",
  "crates/recorder_native/index.node",
];
const custody = Object.fromEntries(
  custodyFiles.map((file) => [
    file,
    sha(fs.readFileSync(path.join(source, file))),
  ]),
);
const links = Object.fromEntries(
  fs
    .readdirSync(path.join(source, "node_modules/@codetracer"))
    .map((name) => [
      name,
      fs.realpathSync(path.join(source, "node_modules/@codetracer", name)),
    ]),
);
const old = fs.readFileSync(path.join(fixture, "declarations-406.ts.txt"));
assert.equal(
  sha(old),
  JSON.parse(fs.readFileSync(path.join(fixture, "origin.json"))).sha256,
);
const replace = (text, before, after) => {
  assert.equal(text.split(before).length, 2, `unique mutation site: ${before}`);
  return text.replace(before, after);
};
function variant(name) {
  const text = original.toString();
  switch (name) {
    case "old-encoder": {
      const begin = text.indexOf("export function declaredArms(");
      const end = text.indexOf("\n/**", begin);
      const historical = old.toString();
      const oldBegin = historical.indexOf("export function declaredArms(");
      const oldEnd = historical.indexOf("\n/**", oldBegin);
      assert(begin >= 0 && end > begin && oldBegin >= 0 && oldEnd > oldBegin);
      return (
        text.slice(0, begin) +
        historical.slice(oldBegin, oldEnd) +
        text.slice(end)
      );
    }
    case "reverse-comparator":
      return replace(
        text,
        "a < b ? -1 : a > b ? 1 : 0",
        "a < b ? 1 : a > b ? -1 : 0",
      );
    case "accept-65":
      return replace(text, "MAX_ARMS = 64", "MAX_ARMS = 65");
    case "accept-257":
      return replace(text, "MAX_ARM_TEXT = 256", "MAX_ARM_TEXT = 257");
    case "partial-prefix-return":
      return replace(
        text,
        '      return "{}";\n    }\n    members.push',
        "      break;\n    }\n    members.push",
      );
    default:
      assert(name.endsWith("-genuine"), `unknown variant ${name}`);
      return text;
  }
}
const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
if (args.includes("--preflight")) {
  assert.equal(manifest.tests.length, 34);
  assert.equal(Object.keys(manifest.failures).length, 5);
  for (const name of Object.keys(manifest.failures)) variant(name);
  console.log(
    "Preflight only: source/fixture/custody paths and five mutation sites valid; zero compiler/browser/control qualification",
  );
  process.exit(0);
}
const root = resolveControlOutputRoot(
  source,
  option("--root") ?? path.join(os.tmpdir(), `ct-arms-${randomUUID()}`),
);
fs.mkdirSync(root, { recursive: true });
const names = Object.keys(manifest.failures).flatMap((name) => [
  name,
  `${name}-genuine`,
]);
const selected = option("--phase");
const phases = selected
  ? [selected]
  : names.flatMap((name) => [`${name}:build`, `${name}:test`]);
function fileHash(file) {
  return sha(fs.readFileSync(file));
}
function run(cwd, argv, log) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(log, (result.stdout ?? "") + (result.stderr ?? ""));
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return result.status;
}
function prepare(name) {
  const dest = path.join(root, name);
  assert(!fs.existsSync(dest), `refuse to overwrite ${dest}`);
  fs.cpSync(source, dest, {
    recursive: true,
    filter: (file) =>
      !file
        .split(path.sep)
        .some((part) =>
          [".git", "node_modules", "dist", "target", ".repro"].includes(part),
        ),
  });
  fs.writeFileSync(path.join(dest, declaration), variant(name));
  const modules = path.join(dest, "node_modules");
  fs.mkdirSync(modules);
  for (const entry of fs.readdirSync(path.join(source, "node_modules"))) {
    if (entry === "@codetracer" || entry === ".bin") continue;
    fs.symlinkSync(
      fs.realpathSync(path.join(source, "node_modules", entry)),
      path.join(modules, entry),
    );
  }
  fs.mkdirSync(path.join(modules, "@codetracer"));
  for (const entry of fs.readdirSync(
    path.join(source, "node_modules/@codetracer"),
  )) {
    const local = path.join(dest, "packages", entry);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(local, "package.json"))).name,
      `@codetracer/${entry}`,
    );
    fs.symlinkSync(local, path.join(modules, "@codetracer", entry));
  }
  fs.mkdirSync(path.join(modules, ".bin"));
  for (const entry of fs.readdirSync(path.join(source, "node_modules/.bin"))) {
    fs.symlinkSync(
      fs.realpathSync(path.join(source, "node_modules/.bin", entry)),
      path.join(modules, ".bin", entry),
    );
  }
  // Native code is unchanged; bind the actual normal-build prerequisite.
  const native = "crates/recorder_native/index.node";
  fs.rmSync(path.join(dest, native), { force: true });
  fs.symlinkSync(
    fs.realpathSync(path.join(source, native)),
    path.join(dest, native),
  );
  return dest;
}
for (const phase of phases) {
  const [name, action] = phase.split(":");
  assert(
    names.includes(name) && ["build", "test"].includes(action),
    `unknown phase ${phase}`,
  );
  const dest = path.join(root, name);
  const receipt = {
    phase,
    source,
    sourceDeclaration: sha(original),
    selectedDeclaration: sha(variant(name)),
    node: process.execPath,
    nodeVersion: process.version,
    start: new Date().toISOString(),
  };
  assert(
    !fs.existsSync(path.join(root, `${name}-${action}-START.json`)),
    "refuse to overwrite an attempted phase; use a fresh evidence root",
  );
  fs.writeFileSync(
    path.join(root, `${name}-${action}-START.json`),
    JSON.stringify(receipt, null, 2),
  );
  try {
    if (action === "build") {
      prepare(name);
      const code = run(
        dest,
        ["npm", "run", "build"],
        path.join(root, `${name}-build.log`),
      );
      assert.equal(code, 0, "real workspace build failed");
      const require = createRequire(path.join(dest, "package.json"));
      const esbuild = require("esbuild");
      const pkg = path.join(dest, "packages/boundary-shim");
      const result = await esbuild.build({
        absWorkingDir: pkg,
        entryPoints: ["src/browser/entry.ts"],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: ["es2020"],
        minify: true,
        keepNames: true,
        legalComments: "none",
        charset: "utf8",
        write: false,
        metafile: true,
      });
      assert(
        Object.keys(result.metafile.inputs).includes(
          "src/browser/declarations.ts",
        ),
        "actual producer not in bundle graph",
      );
      assert.equal(
        sha(result.outputFiles[0].contents),
        fileHash(path.join(pkg, "dist/boundary-shim.iife.js")),
        "normal shipped bundle differs from provenance build",
      );
      receipt.metafile = result.metafile;
      receipt.bundleInputs = Object.fromEntries(
        Object.keys(result.metafile.inputs).map((file) => [
          file,
          fileHash(path.resolve(pkg, file)),
        ]),
      );
      receipt.bindings = {};
      for (const file of [
        declaration,
        "packages/boundary-shim/dist/browser/declarations.js",
        "packages/boundary-shim/dist/boundary-shim.iife.js",
        "packages/boundary-shim/dist/boundary-shim-replay.iife.js",
        "packages/cli/dist/index.js",
        "crates/recorder_native/index.node",
        "tests/boundary/declarations.test.ts",
        "tests/boundary/record-replay.ts",
        "package-lock.json",
      ])
        receipt.bindings[file] = fileHash(path.join(dest, file));
      receipt.nativeRealPath = fs.realpathSync(
        path.join(dest, "crates/recorder_native/index.node"),
      );
      receipt.resolution = {};
      for (const entry of fs.readdirSync(
        path.join(dest, "node_modules/@codetracer"),
      )) {
        const resolved = fs.realpathSync(
          path.join(dest, "node_modules/@codetracer", entry),
        );
        assert.equal(resolved, path.join(dest, "packages", entry));
        receipt.resolution[entry] = resolved;
      }
    } else {
      const built = JSON.parse(
        fs.readFileSync(path.join(root, `${name}-build-RESULT.json`)),
      );
      assert.equal(built.success, true);
      for (const [file, hash] of Object.entries(built.bindings))
        assert.equal(
          fileHash(path.join(dest, file)),
          hash,
          `build input/output changed: ${file}`,
        );
      assert.equal(
        fileHash(path.join(dest, declaration)),
        receipt.selectedDeclaration,
      );
      const report = path.join(root, `${name}-vitest.json`);
      process.env.CT_DECLARED_ARMS_CASES = path.join(
        root,
        `${name}-observed.json`,
      );
      process.env.CT_DECLARED_ARMS_RECEIPT = path.join(
        root,
        `${name}-bootstrap.json`,
      );
      for (const [file, hash] of Object.entries(built.bundleInputs))
        assert.equal(
          fileHash(path.resolve(dest, "packages/boundary-shim", file)),
          hash,
        );
      const code = run(
        dest,
        [
          process.execPath,
          "node_modules/vitest/vitest.mjs",
          "run",
          "tests/boundary/declarations.test.ts",
          "--maxWorkers=1",
          "--reporter=default",
          "--reporter=json",
          `--outputFile=${report}`,
        ],
        path.join(root, `${name}-test.log`),
      );
      const bootstrap = JSON.parse(
        fs.readFileSync(process.env.CT_DECLARED_ARMS_RECEIPT),
      );
      assert.equal(
        bootstrap.bundleSha256,
        built.bindings["packages/boundary-shim/dist/boundary-shim.iife.js"],
      );
      assert.equal(bootstrap.pages.length, 30);
      receipt.bootstrapSha256 = fileHash(process.env.CT_DECLARED_ARMS_RECEIPT);
      const parsed = JSON.parse(fs.readFileSync(report));
      assert.equal(parsed.testResults.length, 1);
      assert.equal(
        parsed.testResults[0].message,
        "",
        "suite/setup/cleanup error",
      );
      assert.equal(parsed.numTotalTests, 34);
      assert.equal(parsed.numPendingTests, 0);
      assert.equal(parsed.numTodoTests, 0);
      assert.equal(parsed.snapshot.failure, false);
      assert(
        !/Unhandled (?:Errors|Rejection|Exception)/.test(
          fs.readFileSync(path.join(root, `${name}-test.log`), "utf8"),
        ),
        "unhandled test error",
      );
      const tests = parsed.testResults.flatMap((file) => file.assertionResults);
      assert.deepEqual(
        tests.map((test) => test.title).sort(),
        [...manifest.tests].sort(),
        "complete frozen 34-case inventory",
      );
      const expected = name.endsWith("-genuine") ? [] : manifest.failures[name];
      const observed = JSON.parse(
        fs.readFileSync(process.env.CT_DECLARED_ARMS_CASES),
      );
      assert.equal(
        Object.keys(observed).length,
        34,
        "actual strict-decoded observations for all cases",
      );
      for (const title of expected) {
        const page = manifest.pages[title];
        assert.deepEqual(
          observed[page].arms,
          [manifest.actualFailures[name][title]],
          `wrong observed producer value: ${title}`,
        );
      }
      receipt.observedSha256 = fileHash(process.env.CT_DECLARED_ARMS_CASES);
      const failed = tests.filter((test) => test.status === "failed");
      assert.deepEqual(
        failed.map((test) => test.title).sort(),
        [...expected].sort(),
        "exact semantic failed names",
      );
      assert.equal(code, expected.length ? 1 : 0);
      for (const test of tests) {
        assert(
          ["passed", "failed"].includes(test.status),
          "skipped/pending test",
        );
        if (test.status === "failed") {
          assert.equal(test.failureMessages.length, 1);
          assert.match(test.failureMessages[0], /AssertionError: expected/);
          const needle =
            name === "old-encoder" && test.title === manifest.ids.A01
              ? "expect(Object.prototype.hasOwnProperty.call(actual, key)).toBe(true);"
              : test.title === manifest.ids.P1
                ? `expect(env?.arms).toBe('{"banner":"blue","checkout":"B"}');`
                : test.title === manifest.ids.P3
                  ? "expect(env?.arms).toBe(ODD_ARMS_CANONICAL);"
                  : "expect(envs[0].arms).toBe(test.expected);";
          const lines = fs
            .readFileSync(
              path.join(dest, "tests/boundary/declarations.test.ts"),
              "utf8",
            )
            .split("\n");
          assert.equal(
            lines.filter((line) => line.trim() === needle).length,
            1,
            "unique exact semantic oracle",
          );
          const location = `${path.join(dest, "tests/boundary/declarations.test.ts")}:${lines.findIndex((line) => line.trim() === needle) + 1}:`;
          assert(
            test.failureMessages[0].includes(location),
            `wrong failed assertion for ${test.title}`,
          );
          assert(
            !/timed out|beforeAll|Error:.*(?:ENOENT|ECONN|Cannot find)/i.test(
              test.failureMessages[0],
            ),
            "setup failure is not semantic evidence",
          );
        }
      }
      receipt.exit = code;
      receipt.failed = failed.map((test) => ({
        title: test.title,
        failureMessages: test.failureMessages,
      }));
      receipt.tests = tests.map((test) => ({
        title: test.title,
        status: test.status,
      }));
      receipt.reportSha256 = fileHash(report);
      receipt.buildReceiptSha256 = fileHash(
        path.join(root, `${name}-build-RESULT.json`),
      );
      for (const [file, hash] of Object.entries(built.bindings))
        assert.equal(
          fileHash(path.join(dest, file)),
          hash,
          `consumer changed input/output: ${file}`,
        );
    }
    receipt.success = true;
  } catch (error) {
    receipt.success = false;
    receipt.error = String(error.stack ?? error);
    throw error;
  } finally {
    for (const [file, hash] of Object.entries(custody))
      assert.equal(
        fileHash(path.join(source, file)),
        hash,
        `candidate changed: ${file}`,
      );
    for (const [name, target] of Object.entries(links))
      assert.equal(
        fs.realpathSync(path.join(source, "node_modules/@codetracer", name)),
        target,
      );
    receipt.candidateCustody = custody;
    receipt.candidateLinks = links;
    assert.equal(
      fileHash(path.join(source, declaration)),
      sha(original),
      "candidate production source changed",
    );
    receipt.end = new Date().toISOString();
    fs.writeFileSync(
      path.join(root, `${name}-${action}-RESULT.json`),
      JSON.stringify(receipt, null, 2),
    );
    console.log(phase, receipt.success ? "PASS" : "FAIL", root);
  }
}

if (!selected) {
  const results = Object.fromEntries(
    phases.map((phase) => {
      const [name, action] = phase.split(":");
      const file = path.join(root, `${name}-${action}-RESULT.json`);
      assert.equal(JSON.parse(fs.readFileSync(file)).success, true);
      return [phase, fileHash(file)];
    }),
  );
  fs.writeFileSync(
    path.join(root, "COMPLETE.json"),
    JSON.stringify(
      {
        controls: 5,
        separatelyRebuiltGenuineCompanions: 5,
        testsPerRun: 34,
        results,
      },
      null,
      2,
    ),
  );
}
