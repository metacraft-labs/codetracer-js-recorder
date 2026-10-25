/**
 * The dynamic `import()` seam, replay side (CodeTracer's
 * JS-Boundary-Recording specification §6, §10.5; the record side is
 * `../seams-import.ts`).
 *
 * The call is matched against its `TaskReg{kind 13}`, but the page's
 * `import()` is not called yet: the module is fetched and evaluated only
 * when the scheduler starts it (`onTaskStart`), because its evaluation is
 * page code, which ran on record where the log has its reads (just before
 * the import's `Task`). The page's promise settles when the scheduler
 * releases that `Task`, with the platform's own outcome.
 *
 * Only a session whose `Header.capabilities` declares the seam (the deploy
 * step was asked for it, `--import-seam`, §8.1) has its imports in the log;
 * for any other the replay runtime's own seam stays, which refuses the
 * page's first dynamic import (`NonReplayable`, §6).
 */

import { IMPORT_SEAM_GLOBAL, sessionHasImportSeam } from "../config.js";
import { TaskKind } from "../recorder.js";
import type { ImportLoad } from "../seams-import.js";
import type { ReplayContext } from "./context.js";

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Install the seam as `globalThis.__ctBoundaryImport`. */
export function replayImportSeam(ctx: ReplayContext): void {
  const { w, replay, orig } = ctx;
  if (!sessionHasImportSeam(replay.header.capabilities)) return;
  const then = orig.promiseThen as Promise<unknown>["then"];
  const seam = function (
    load: ImportLoad,
    specifier: unknown,
    options?: unknown,
  ): Promise<unknown> {
    const two = arguments.length > 2;
    const id = ctx.nextTaskId();
    replay.registerTask(id, TaskKind.platform, 0);
    let platform: Promise<Outcome> | undefined;
    const start = (): Promise<Outcome> => {
      platform ??= new orig.Promise<Outcome>((done) => {
        let p: Promise<unknown>;
        try {
          p = two ? load(specifier, options) : load(specifier);
        } catch (error) {
          done({ ok: false, error });
          return;
        }
        then.call(
          p,
          (value) => done({ ok: true, value }),
          (error: unknown) => done({ ok: false, error }),
        );
      });
      return platform;
    };
    const settledThen = then as Promise<Outcome>["then"];
    return new orig.Promise<unknown>((resolve, reject) => {
      replay.onTaskStart(
        id,
        () => settledThen.call(start(), () => undefined) as Promise<void>,
      );
      replay.onTask(
        id,
        () =>
          settledThen.call(start(), (o) => {
            replay.offTask(id);
            if (o.ok) resolve(o.value);
            else reject(o.error);
          }) as Promise<void>,
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
