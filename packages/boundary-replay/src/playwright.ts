/**
 * The headless Chromium the replay runner (and the conformance suite, which
 * re-exports this module) drives, through playwright-core.
 *
 * playwright-core is not a dependency of these packages: the caller's
 * environment supplies the browser. It is loaded from `PLAYWRIGHT_CORE_PATH`
 * when set (a Nix dev shell exports it, with `PLAYWRIGHT_BROWSERS_PATH`,
 * from nixpkgs' `playwright-driver`), else from the `playwright-core`
 * package Node resolves from the working directory. Without either the
 * caller fails, naming both, rather than skip.
 */

import { createRequire } from "node:module";
import * as path from "node:path";

/** The slice of playwright-core's API the runner and the harness use. */
export interface Playwright {
  chromium: {
    launch(options?: { headless?: boolean; args?: string[] }): Promise<Browser>;
  };
}
export interface Browser {
  newContext(options?: ContextOptions): Promise<BrowserContext>;
  version(): string;
  close(): Promise<void>;
}
export interface ContextOptions {
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  locale?: string;
  timezoneId?: string;
  colorScheme?: "light" | "dark" | "no-preference";
  reducedMotion?: "reduce" | "no-preference";
  serviceWorkers?: "allow" | "block";
  /**
   * The context's proxy: every connection the browser makes goes to
   * `server` unless `bypass` (Chromium's proxy bypass rules, comma
   * separated) names its host.
   */
  proxy?: { server: string; bypass?: string };
}
export interface BrowserContext {
  newPage(): Promise<Page>;
  route(
    url: string,
    handler: (route: Route, request: Request) => Promise<void> | void,
  ): Promise<void>;
  addInitScript(script: { content: string } | { path: string }): Promise<void>;
  /** A function the page can call, which runs `callback` in Node. */
  exposeBinding(
    name: string,
    callback: (source: unknown, ...args: unknown[]) => unknown,
  ): Promise<void>;
  close(): Promise<void>;
}
export interface Route {
  fulfill(options: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
  }): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}
export interface Request {
  url(): string;
  method(): string;
  resourceType(): string;
  isNavigationRequest(): boolean;
  /** The request's headers, lower-case names. */
  headers(): Record<string, string>;
  /** The frame that made the request (for a navigation, the one navigated). */
  frame(): Frame;
}
export interface Frame {
  /** `null` for the page's main frame. */
  parentFrame(): Frame | null;
}
export interface Page {
  goto(
    url: string,
    options?: { timeout?: number; waitUntil?: "commit" | "load" },
  ): Promise<unknown>;
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
  /** Key presses at the focused element (Playwright's `page.keyboard`). */
  keyboard: { press(key: string): Promise<void> };
  /** The pointer (Playwright's `page.mouse`). */
  mouse: { move(x: number, y: number): Promise<void> };
  focus(selector: string, options?: { timeout?: number }): Promise<void>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  on(event: "pageerror", f: (e: Error) => void): void;
  close(): Promise<void>;
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
