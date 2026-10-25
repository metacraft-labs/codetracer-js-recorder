/**
 * The dynamic `import()` seam, record side (CodeTracer's
 * JS-Boundary-Recording specification §6, §10.1).
 *
 * A dynamic `import()` fetches a module graph outside any script element
 * and evaluates it in a task of its own when the network delivers it; its
 * promise settles after the evaluation, and the page's continuation runs
 * then. Both the evaluation (the module's top-level code) and the
 * continuation are page code whose place among the page's other tasks
 * depends on the network. A page cannot patch the host hook behind
 * `import()` (it is syntax, not a function), so the deploy step rewrites
 * each `import(x)` of the bundle into a call of this seam
 * (`../import-seam.ts`): the call writes `TaskReg{kind 13}`, a platform task
 * (§6), and the settlement its `Task`, before the page's continuation. The
 * module's evaluation runs before the settlement, so its reads precede the
 * `Task`; replay starts the import when they come due (`onTaskStart`). No
 * checkpoint is taken at the settlement: page code of the same platform task
 * (the evaluation) already ran.
 */

import { IMPORT_SEAM_GLOBAL } from "./config.js";
import type { SeamContext } from "./context.js";
import { TaskKind } from "./recorder.js";

/** The import as the rewritten call hands it to the seam. */
export type ImportLoad = (
  specifier: unknown,
  options?: unknown,
) => Promise<unknown>;

/** Install the seam as `globalThis.__ctBoundaryImport`. */
export function patchImportSeam(ctx: SeamContext): void {
  const { w, rec, orig } = ctx;
  const seam = function (
    load: ImportLoad,
    specifier: unknown,
    options?: unknown,
  ): Promise<unknown> {
    // The page's own import(), called now, from its module.
    const settled =
      arguments.length > 2 ? load(specifier, options) : load(specifier);
    if (!rec.recording) return settled;
    const taskId = rec.guard(() => {
      const id = rec.nextTaskId();
      rec.emit("TaskReg", {
        task_id: id,
        kind: TaskKind.platform,
        delay_ms: 0,
      });
      return id;
    });
    if (taskId === undefined) return settled;
    const task = () =>
      rec.guard(() => rec.taskWithoutCheckpoint(taskId, TaskKind.platform));
    return new orig.Promise<unknown>((resolve, reject) => {
      (orig.promiseThen as Promise<unknown>["then"]).call(
        settled,
        (v) => {
          task();
          resolve(v);
        },
        (e: unknown) => {
          task();
          reject(e);
        },
      );
    });
  };
  Object.defineProperty(w, IMPORT_SEAM_GLOBAL, {
    value: seam,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
