/** Resolve output custody before creating directories or receipts.
 * Follow existing aliases, including aliases in a not-yet-created path's
 * parent, so an output cannot accidentally write back into its input tree.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

export function resolveControlOutputRoot(source, requested) {
  const sourceRoot = fs.realpathSync(source);
  let ancestor = path.resolve(requested);
  const missing = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      assert.notEqual(parent, ancestor, "output has no existing ancestor");
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  // realpath also fails closed on a dangling existing alias.
  const resolved = path.resolve(fs.realpathSync(ancestor), ...missing);
  const relative = path.relative(sourceRoot, resolved);
  assert(
    relative !== "" &&
      (relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)),
    "outputs must be outside source",
  );
  return resolved;
}
