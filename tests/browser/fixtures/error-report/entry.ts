// The fixture page's copy of the error reporter: the shipped module, bundled
// by tests/browser/error-report.test.ts into one classic script that exposes
// it as `CtErrorReporter`, as a site's bundler would bundle the package.
import { installErrorReporter } from "../../../../packages/runtime-browser/src/error-report.js";

(globalThis as unknown as { CtErrorReporter: unknown }).CtErrorReporter = {
  installErrorReporter,
};
