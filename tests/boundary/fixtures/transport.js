// The page of tests/boundary/transport.test.ts: it makes boundary reads at
// rates the tests choose, through the platform functions the shim records.
//
// - `#one`: one click, one `Date.now()`;
// - `#burst` (2000) and `#burst-600` (600): one click, that many
//   `Math.random()` reads in the same task, each value kept in
//   `window.__randoms` so a test can tell which records reached the ingest;
// - `#ticks`: a 5 ms `setInterval` whose 150 ticks each read
//   `performance.now()`; `#steady-slow` (480 ticks of 25 ms),
//   `#steady-fast` (2000 ticks of 5 ms) and `#ticks-slow` (80 ticks of
//   25 ms, reporting in `#ticks-done`), do the same at the interval and
//   count in their `data-interval` and `data-n`, each reporting in its own
//   `data-done` element. Each run of ticks also reads `performance.now()`
//   once just before its `setInterval`, and reports that time, its
//   interval and its count in `window.__ctTickRuns`, from which the
//   flush-deadline oracle bounds when each tick came due.
//
// `?consent=yes|no`, or `data-consent` on the root element (as in
// `transport-consent.html`, for a session that is replayed: the recorded
// URL has no query), registers the site's consent callback with the shim
// (`__ctBoundaryShim.consent`), answering that. The callback makes a
// boundary read (`Date.now()`), so a replay that called it at another point
// than the recording did, or not at all, diverges.
(function () {
  "use strict";
  var shim = window.__ctBoundaryShim;
  var consent =
    document.documentElement.getAttribute("data-consent") ||
    new URLSearchParams(location.search).get("consent");
  if (shim !== undefined && consent !== null) {
    shim.consent(function () {
      return Date.now() > 0 && consent === "yes";
    });
  }

  var clicks = 0;
  document.getElementById("one").addEventListener("click", function () {
    clicks += Date.now() > 0 ? 1 : 0;
    document.getElementById("clicks").textContent = String(clicks);
  });

  function burst(e) {
    var n = Number(e.currentTarget.getAttribute("data-n"));
    var values = [];
    for (var i = 0; i < n; i++) values.push(Math.random());
    window.__randoms = values;
    document.getElementById("burst-done").textContent = String(n);
  }
  document.getElementById("burst").addEventListener("click", burst);
  document.getElementById("burst-600").addEventListener("click", burst);

  function ticks(e) {
    var button = e.currentTarget;
    var n = Number(button.getAttribute("data-n"));
    var interval = Number(button.getAttribute("data-interval") || "5");
    var done = button.getAttribute("data-done") || "ticks-done";
    var seen = 0;
    // The interval's grid starts no earlier than this read (Chromium runs a
    // repeating timer on a drift-free grid from its start), so the test can
    // bound when each tick came due, not only when it ran.
    var t0 = performance.now();
    (window.__ctTickRuns = window.__ctTickRuns || []).push({
      t0: t0,
      interval: interval,
      ticks: n,
    });
    var timer = setInterval(function () {
      performance.now();
      seen += 1;
      if (seen === n) {
        clearInterval(timer);
        document.getElementById(done).textContent = String(n);
      }
    }, interval);
  }
  document.getElementById("ticks").addEventListener("click", ticks);
  document.getElementById("steady-slow").addEventListener("click", ticks);
  document.getElementById("steady-fast").addEventListener("click", ticks);
  document.getElementById("ticks-slow").addEventListener("click", ticks);
})();
