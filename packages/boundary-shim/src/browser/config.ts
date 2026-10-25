/**
 * Names and shapes shared by the shim's browser half and its Node half
 * (the HTML injector). Kept free of DOM and Node APIs so both compile it.
 */

/**
 * The global the bootstrap `<script>` sets before the shim bundle runs.
 * Its value is a {@link ShimConfig}.
 */
export const CONFIG_GLOBAL = "__ctBoundaryShimConfig";

/**
 * The global the installed shim publishes its control surface on
 * ({@link ShimControl} in `install.ts`): the originals it captured before
 * patching, the log, and `stop()`.
 */
export const CONTROL_GLOBAL = "__ctBoundaryShim";

/**
 * The attribute that marks the bootstrap `<script>` the injector inserts,
 * so a second injection replaces it instead of adding another.
 */
export const BOOTSTRAP_MARKER = "data-codetracer-boundary-shim";

/** What the bootstrap hands the shim. */
export interface ShimConfig {
  /**
   * `Header.build_hash` (JS-Boundary-Recording.md §8): the lowercase hex
   * SHA-256 of the deployed bundle's canonical `ct-bundle.json`. Empty
   * until a deploy step computes one.
   */
  buildHash?: string;
  /**
   * `Header.prev_session`: the session this page lifetime continues, when
   * the caller knows it. Empty otherwise.
   */
  prevSession?: string;
  /**
   * The ingest's base URL, absolute or relative to the page
   * (Boundary-Ingest §3: `/api/v1/ingest/js-boundary/<site key>`). When
   * set, the shim uploads its log through `HttpBatchTransport`
   * (JS-Boundary-Recording.md §11.1): `GET <ingest>/config`, then batches
   * to `POST <ingest>/batches`. When absent, the log stays in the page
   * and leaves it only through the control surface's `log()` (§10.4).
   */
  ingest?: string;
  /**
   * The site requires consent: nothing is requested from the ingest until
   * the page's consent callback (`__ctBoundaryShim.consent(callback)`)
   * answers yes (§11.2). The log is kept, capped, in the page meanwhile.
   */
  consentRequired?: boolean;
  /** The upload ring's cap in bytes until the ingest's configuration sets one. */
  ringBytes?: number;
  /**
   * The deploy step rewrote the page's dynamic `import()` calls into calls
   * of the shim's seam ({@link IMPORT_SEAM_GLOBAL}), which it does only when
   * asked (`boundary-shim --import-seam`, the vite plugin's `importSeam`;
   * JS-Boundary-Recording.md §8.1). The shim then installs the seam and
   * declares it in `Header.capabilities` ({@link IMPORT_SEAM_CAPABILITY}),
   * so that replay orders each import as a platform task. Without it a
   * dynamic import is not ordered by the log, and replay refuses the session
   * from the page's first call (`NonReplayable`, JBR-AREQ4).
   */
  importSeam?: boolean;
}

/**
 * The `Header.capabilities` entry of a session whose page's dynamic
 * `import()` calls go through the recorder's seam (§5.2, §6, §8.1): replay
 * orders the imports of such a session, and refuses any other's.
 */
export const IMPORT_SEAM_CAPABILITY = "import-seam";

/**
 * Whether a session's `Header.capabilities` (a JSON array of strings,
 * §5.2) declares {@link IMPORT_SEAM_CAPABILITY}. Anything that is not such
 * an array declares nothing.
 */
export function sessionHasImportSeam(capabilities: string): boolean {
  try {
    const caps: unknown = JSON.parse(capabilities);
    return Array.isArray(caps) && caps.includes(IMPORT_SEAM_CAPABILITY);
  } catch {
    return false;
  }
}

/**
 * The dynamic `import()` seam (JS-Boundary-Recording.md §6, §10.1): the
 * global function a page's rewritten `import(x)` calls as
 * `__ctBoundaryImport((s) => import(s), x)`, so that the recorder sees the
 * call and its settlement while the `import()` itself stays in the page's
 * own module (its specifier resolves against that module's URL). The
 * rewrite is `rewriteDynamicImports` (`../import-seam.ts`), applied by the
 * `boundary-shim` deploy step when asked (`--import-seam`) and, always, by
 * the replay runner, whose seam refuses an import the log does not order.
 */
export const IMPORT_SEAM_GLOBAL = "__ctBoundaryImport";

/**
 * What the rewrite puts in place of the `import` keyword: the seam, or,
 * where no shim installed one (Do Not Track, a worker, a page without the
 * bootstrap), a function that calls the `import()` as written.
 */
export const IMPORT_SEAM_CALLEE = `(globalThis.${IMPORT_SEAM_GLOBAL}||((f,s,o)=>f(s,o)))`;

/**
 * What the rewrite inserts after the call's `(`: the `import()` as a
 * function of its specifier, for a call with one argument and with two.
 */
export const IMPORT_SEAM_LOAD_1 = "(__ctS)=>import(__ctS),";
export const IMPORT_SEAM_LOAD_2 = "(__ctS,__ctO)=>import(__ctS,__ctO),";

/** The recorder identity written to `Header.recorder_id`. */
export const RECORDER_NAME = "codetracer-boundary-shim";
