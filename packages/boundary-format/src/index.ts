/**
 * `@codetracer/boundary-format`: the JS boundary log (`jsbound.log`) of
 * CodeTracer's browser boundary recording — its records, an encoder, a
 * strict decoder and the canonical JSON form.
 *
 * The format is specified by CodeTracer's JS-Boundary-Recording
 * specification §5. The Rust implementation (codetracer `libs/jsbound`,
 * which also assembles uploaded batches into a recording) and this one are
 * held to one set of byte vectors, vendored here under
 * `tests/boundary/vectors/`.
 */

export * from "./schema.js";
export * from "./codec.js";
export * from "./json.js";
export * from "./batch.js";
export * from "./checkpoint-index.js";
