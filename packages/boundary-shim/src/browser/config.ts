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
}

/** The recorder identity written to `Header.recorder_id`. */
export const RECORDER_NAME = "codetracer-boundary-shim";
