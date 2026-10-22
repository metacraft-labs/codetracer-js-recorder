// Installed by the test with page.addInitScript, before the shim, in both
// arms of the behaviour comparison: Math.random and crypto.getRandomValues
// draw from one seeded generator (mulberry32), so the two arms see the same
// values and any difference in the page's DOM is the shim's doing.
//
// The page's first statement calls `__seedRandom()`, which restarts the
// sequence: the recorder draws its session id from crypto.getRandomValues
// while it installs, before the page runs, and the pin is on the values the
// PAGE sees, from its first statement on, as it is in the counting layer.
(function () {
  var SEED = 0x2f6b1c3d;
  var state = SEED;
  Object.defineProperty(window, "__seedRandom", {
    value: function () {
      state = SEED;
    },
  });
  function next() {
    state = (state + 0x6d2b79f5) | 0;
    var t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  Math.random = function random() {
    return next();
  };
  Crypto.prototype.getRandomValues = function getRandomValues(array) {
    var bytes = new Uint8Array(
      array.buffer,
      array.byteOffset,
      array.byteLength,
    );
    for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
    return array;
  };
})();
