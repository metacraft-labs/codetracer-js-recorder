/**
 * The headless Chromium the harness drives, through playwright-core.
 *
 * playwright-core is not a dependency of this package: a framework's
 * repository supplies the browser it tests against. It is loaded from
 * `PLAYWRIGHT_CORE_PATH` when set (a Nix dev shell exports it, with
 * `PLAYWRIGHT_BROWSERS_PATH`, from nixpkgs' `playwright-driver`), else from
 * the `playwright-core` package Node resolves from the working directory.
 * Without either the harness fails, naming both, rather than skip.
 */

import { createRequire } from "node:module";
import * as path from "node:path";

/** The slice of playwright-core's API the harness uses. */
export interface Playwright {
  chromium: { launch(options?: { headless?: boolean }): Promise<Browser> };
}
export interface Browser {
  newContext(): Promise<BrowserContext>;
  close(): Promise<void>;
}
export interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
export interface Page {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  goBack(options?: {
    timeout?: number;
    waitUntil?: "commit" | "load";
  }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  type(
    selector: string,
    text: string,
    options?: { timeout?: number },
  ): Promise<void>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  on(event: "pageerror", f: (e: Error) => void): void;
}

/** Load playwright-core (see the module comment). */
export function loadPlaywright(): Playwright {
  const fromEnv = process.env.PLAYWRIGHT_CORE_PATH;
  const req = createRequire(path.join(process.cwd(), "noop.js"));
  try {
    return req(
      fromEnv !== undefined && fromEnv !== "" ? fromEnv : "playwright-core",
    ) as Playwright;
  } catch (e) {
    throw new Error(
      "cannot load playwright-core: set PLAYWRIGHT_CORE_PATH (and PLAYWRIGHT_BROWSERS_PATH), " +
        "as a Nix dev shell with nixpkgs' playwright-driver does, or install playwright-core " +
        `where Node resolves it from ${process.cwd()} (${(e as Error).message})`,
    );
  }
}
