// Driver for the transitive composition end-to-end test.
//
// Loads the minified library (whose upstream V3 sourcemap maps each
// minified position back to a name in `original.js`).  The recorder's
// autoformat pass produces a `minified.fmt.js` formatted view + an
// inverse V3 sourcemap (formatted → recorded-minified).  The replay-
// server's `SourcemapCache` then composes the inverse map with the
// upstream sourcemap so a position observed in the formatted view
// resolves to an `original.js` name, which finally goes through the
// renames.toml lookup to surface `addNumbers`.
require("./minified.js");
