/**
 * Listing the files of a directory tree in an order that is the same on
 * every machine.
 *
 * Build identity depends on it: the CLI mints
 * manifest id blocks in the order it instruments files, and those ids are
 * baked into the emitted code, so instrumenting the same bundle twice is
 * byte-identical only if the files are visited in the same order both
 * times. The order a directory lists its entries in is the filesystem's
 * (tmpfs lists them newest first, ZFS and ext4 by a hash of the name), and
 * Node does not promise one (`fs.readdirSync` happens to come back sorted
 * on Unix because libuv's `scandir` sorts, an implementation detail; a
 * recursive walk over it still interleaves `a/x.js` before `a.js`). So the
 * walk reads entries in the filesystem's own order (`fs.opendirSync`) and
 * the result is sorted explicitly, by the UTF-8 bytes of the relative
 * path, which is also the order `ct-bundle.json` lists its files in.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Options of {@link sortedFilesUnder}. */
export interface SortedFilesOptions {
  /**
   * Throw on an entry that is neither a regular file nor a directory
   * (a symbolic link, a socket, …) instead of skipping it. A manifest
   * that silently left such an entry out would describe a different
   * set of files than the directory serves.
   */
  rejectOtherEntries?: boolean;
  /** Directory names not descended into (matched against the entry name). */
  skipDirectories?: readonly string[];
}

/** Compare two strings by their UTF-8 bytes (code point order). */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

/**
 * The regular files under `root` whose `/`-separated path relative to
 * `root` satisfies `accept`, as such relative paths, sorted by
 * {@link compareUtf8}.
 */
export function sortedFilesUnder(
  root: string,
  accept: (relativePath: string) => boolean,
  options: SortedFilesOptions = {},
): string[] {
  const out: string[] = [];
  const skip = new Set(options.skipDirectories ?? []);
  const walk = (dir: string, rel: string): void => {
    const handle = fs.opendirSync(dir);
    try {
      for (
        let entry = handle.readSync();
        entry !== null;
        entry = handle.readSync()
      ) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(path.join(dir, entry.name), childRel);
        } else if (entry.isFile()) {
          if (accept(childRel)) out.push(childRel);
        } else if (options.rejectOtherEntries) {
          throw new Error(
            `${path.join(dir, entry.name)} is neither a regular file nor a directory`,
          );
        }
      }
    } finally {
      handle.closeSync();
    }
  };
  walk(root, "");
  return out.sort(compareUtf8);
}
