/**
 * The names the cooperation protocol and its conformance suite share with
 * every framework that implements the protocol (CodeTracer's
 * JS-Boundary-Recording specification, §9). Kept free of DOM and Node APIs
 * so the browser probe, the reference framework and the Node harness all
 * compile it.
 */

/** The protocol version this suite defines (`__ctBoundaryProtocol.protocol`). */
export const PROTOCOL_VERSION = 1;

/** The global a cooperating framework declares itself on (§9.2). */
export const PROTOCOL_GLOBAL = "__ctBoundaryProtocol";

/**
 * The capabilities every level-1 declaration must list (§9.2). `sensitive`
 * is required too, but by the non-interference leg, which checks what it
 * promises; the record leg checks these four.
 */
export const REQUIRED_CAPABILITIES: readonly string[] = [
  "input",
  "targets",
  "inject",
  "checkpoint",
];

/** A protocol level (§9.1): 0 the generic shim, 1 a cooperating framework. */
export type ProtocolLevel = 0 | 1;

/**
 * The record hooks a level-1 framework publishes as
 * `__ctBoundaryProtocol.record` while it records (§9.2, §9.5). The harness
 * calls nothing else.
 */
export interface RecordHooks {
  /**
   * End the session as an explicit stop: a final checkpoint when anything
   * was written since the last one, then `End{reason: 2}`; then upload
   * every batch not yet sent, the last with `final: true`. Resolves once
   * the last batch has been answered.
   */
  stop(): void | Promise<void>;
  /**
   * The node a target string (§9.3) names now: the element for `iid:` and
   * `ord:`, the document for `doc`, the window for `win`; `null` when it
   * names nothing.
   */
  resolveTarget(target: string): Element | Document | Window | null;
}

/** The declaration of §9.2, as the record leg reads it. */
export interface ProtocolDeclaration {
  protocol: number;
  framework: string;
  capabilities: string[];
  record?: RecordHooks;
}

/**
 * The routes the harness's server answers besides the build's files. A
 * framework's build of the fixtures uses them exactly (§9.9): the ingest
 * routes are where a build uploads (the generic build's shim is installed
 * with `--ingest /ct-conformance`), and the API routes are the fixtures'
 * backend.
 */
export const ROUTES = {
  /**
   * The ingest base URL (Boundary-Ingest §3): `<ingest>/config` and
   * `<ingest>/batches` are the two routes below.
   */
  ingest: "/ct-conformance",
  /** `GET`: the recorder configuration, answered `{"enabled": true}`. */
  config: "/ct-conformance/config",
  /** `POST`: one batch body (Boundary-Ingest §4), answered `202`. */
  batches: "/ct-conformance/batches",
  /** `GET`: the fetch-driven list's items, a JSON array. */
  items: "/ct-conformance/api/items",
  /** `POST` a JSON `{user, pass}`: answers `{"ok": true, "user": user}`. */
  login: "/ct-conformance/api/login",
  /** `GET`: answered `ok` only when the harness releases it. */
  hydrateGate: "/ct-conformance/hydrate-gate",
} as const;

/** What `GET /ct-conformance/api/items` answers. */
export const ITEMS = [
  { id: 1, name: "alpha" },
  { id: 2, name: "beta" },
  { id: 3, name: "gamma" },
] as const;

/** The page of a fixture in a build, and its perturbed twin (§9.9). */
export function fixturePage(fixture: string, perturbed = false): string {
  return `/${fixture}/${perturbed ? "perturbed" : "index"}.html`;
}

/** The attribute that names the elements a fixture's script touches. */
export const FIXTURE_ATTRIBUTE = "data-fx";

/** A check's outcome in the report (§9.9). */
export type CheckStatus = "pass" | "fail" | "not-applicable-at-level-0";

/** The checks of the record leg, in report order (§9.9). */
export const RECORD_CHECKS = [
  "interaction",
  "decode",
  "header",
  "declaration",
  "inputs",
  "targets",
  "checkpoints",
  "reads",
  "envelope",
] as const;

/** A record-leg check's name. */
export type RecordCheckName = (typeof RECORD_CHECKS)[number];

/**
 * The checks that apply only at level 1. `declaration` and `targets` are
 * level-1 properties by definition (§9.1, §9.2, §9.3). `envelope` applies
 * at both levels: the generic shim uploads through `HttpBatchTransport`
 * (§11.1) as a framework uploads through it or its own transport.
 */
export const LEVEL_1_ONLY: ReadonlySet<RecordCheckName> = new Set([
  "declaration",
  "targets",
]);

/** The checks of the replay leg, in report order (§9.9). */
export const REPLAY_CHECKS = ["replay", "inject", "divergence"] as const;

/** A replay-leg check's name. */
export type ReplayCheckName = (typeof REPLAY_CHECKS)[number];

/**
 * The replay-leg checks that apply only at level 1: `inject` is the
 * framework calling its registered handler (§9.5); at level 0 the generic
 * shim injects synthetic events (§10.3), which `replay` covers.
 */
export const REPLAY_LEVEL_1_ONLY: ReadonlySet<ReplayCheckName> = new Set([
  "inject",
]);
