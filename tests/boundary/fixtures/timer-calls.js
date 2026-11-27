// Installed by the test with page.addInitScript, before every script of the
// page and before the boundary shim's bootstrap (as counting-layer.js is).
// It wraps `window.setTimeout` in place and counts the calls, and the shim
// captures the wrapper as its original, so a timer the shim schedules through
// the platform's function is counted too. `window.__timerCalls` is the count.
// The test compares it between the shimmed page and the plain one: a shim that
// settled the page's promises through a timer would make more calls.
(function () {
  var platform = window.setTimeout;
  var calls = 0;
  window.setTimeout = function () {
    calls++;
    return platform.apply(this, arguments);
  };
  Object.defineProperty(window, "__timerCalls", {
    get: function () {
      return calls;
    },
  });
})();
