// The fixture page of tests/boundary/seeking.test.ts (range materialisation
// and divergence localisation, CodeTracer's JS-Boundary-Recording
// specification §7.3, §12).
//
// Each click on #go makes more than 256 boundary reads (Math.random), so the
// recorder's checkpoint cadence (one is due after 256 records) puts a
// checkpoint at the start of the next task: every click is followed by one,
// and a session of CLICKS clicks has checkpoints spread over its whole log.
// Each click also runs a timer and a fetch, so the trace has steps in tasks
// of three kinds between two checkpoints.
//
// The third click reads the offsetWidth of #half, whose width is half the
// viewport's, and writes it into the document. A shim that records the read
// replays it from the log; one that misses it lets a replay at another
// viewport write another number, which the next checkpoint's hash sees.
// The storage read with the key `seeking-before-offsetWidth` comes right
// before that read, so a test can find where in the log it happened even
// when the read itself is not there.
//
// The page counts finished clicks in `data-finished` and sets
// `data-done="1"` after the last one, for the test to wait on.
(function () {
  var CLICKS = 6;
  var WIDTH_CLICK = 3;
  var clicks = 0;
  var finished = 0;

  function show(label, value) {
    document.getElementById("r-" + label).textContent = label + "=" + value;
  }

  function settle(parts) {
    if (--parts.left === 0) {
      finished++;
      document.body.setAttribute("data-finished", String(finished));
      if (finished === CLICKS) document.body.setAttribute("data-done", "1");
    }
  }

  function onGo() {
    clicks += 1;
    var parts = { left: 2 };
    var sum = 0;
    for (var i = 0; i < 260; i++) sum += Math.random();
    show("sum", sum.toFixed(6));
    show("now", Date.now());
    show("ls", String(localStorage.getItem("seeking-" + (clicks % 2))));
    localStorage.setItem("seeking-" + (clicks % 2), String(clicks));
    if (clicks === WIDTH_CLICK) {
      localStorage.getItem("seeking-before-offsetWidth");
      show("width", document.getElementById("half").offsetWidth);
    }
    document.getElementById("count").textContent = String(clicks);
    setTimeout(function () {
      show("timeout", Date.now());
      settle(parts);
    }, 5);
    fetch("/api/data?click=" + clicks)
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        show("fetch", j.value + "/" + clicks);
        settle(parts);
      });
  } // end of onGo

  document.getElementById("go").addEventListener("click", onGo);
})();
