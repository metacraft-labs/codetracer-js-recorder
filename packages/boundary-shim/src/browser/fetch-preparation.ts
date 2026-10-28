/**
 * Within this owner-library module instance, one fetch closure owns a realm's
 * response metadata and body queues. Share one library instance/callable;
 * independently bundled copies do not share this reservation. Replacing
 * those prototype wrappers with another closure would strand earlier responses.
 * Keep preparation separate from task/request ids and from global installation.
 * No map is allocated merely by importing this module.
 */
interface Preparation {
  context: object;
  mode: "record" | "replay";
  fetch?: typeof fetch;
}
let preparations: WeakMap<object, Preparation> | undefined;

/** Internal shared reservation for the record/replay fetch library factories. */
export function prepareFetch(
  realm: object,
  context: object,
  mode: Preparation["mode"],
  make: () => typeof fetch,
): typeof fetch {
  const previous = preparations?.get(realm);
  if (previous !== undefined) {
    if (previous.context !== context || previous.mode !== mode) {
      throw new TypeError(
        "fetch preparation belongs to another context or mode",
      );
    }
    if (previous.fetch === undefined) {
      throw new TypeError("fetch preparation is incomplete or failed");
    }
    return previous.fetch;
  }
  const preparation: Preparation = { context, mode };
  (preparations ??= new WeakMap()).set(realm, preparation);
  // A failed setup may have changed a prototype. Retain the reservation rather
  // than retrying over a partial installation; propagate its original error.
  preparation.fetch = make();
  return preparation.fetch;
}
