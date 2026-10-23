// The fixture page of tests/boundary/replay.test.ts: a session recorded on
// it by the generic shim is replayed against an instrumented copy of this
// file, and the trace must hold steps inside `onGo`, the click handler.
//
// Each click on #go makes every kind of boundary read the shim logs (clocks,
// random sources, storage, layout, a timer, an animation frame, a fetch and
// an XHR against the fixture server) and more than 256 records, so the
// recorder's checkpoint cadence (one is due after 256 records) puts a
// checkpoint at the start of the next task: twelve clicks give the session
// at least ten. Each result lands in its own slot, so the final document
// does not depend on the order the asynchronous reads complete in; the page
// counts finished clicks in `data-finished` for the test to wait on.
(function () {
  var clicks = 0;
  var finished = 0;

  function show(label, value) {
    document.getElementById("r-" + label).textContent = label + "=" + value;
  }

  function settle(parts) {
    if (--parts.left === 0) {
      finished++;
      document.body.setAttribute("data-finished", String(finished));
    }
  }

  function onGo() {
    clicks += 1;
    var parts = { left: 4 };
    var sum = 0;
    for (var i = 0; i < 260; i++) sum += Math.random();
    show("sum", sum.toFixed(6));
    show("now", Date.now());
    show("perf", Math.round(performance.now()));
    show("ls", String(localStorage.getItem("replay-" + (clicks % 3))));
    localStorage.setItem("replay-" + (clicks % 3), String(clicks));
    var rect = document.getElementById("box").getBoundingClientRect();
    show("rect", rect.width + "x" + rect.height);
    document.getElementById("count").textContent = String(clicks);
    setTimeout(function () {
      show("timeout", Date.now());
      settle(parts);
    }, 5);
    requestAnimationFrame(function (ts) {
      show("raf", typeof ts);
      settle(parts);
    });
    fetch("/api/data?click=" + clicks)
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        show("fetch", j.value + "/" + clicks);
        settle(parts);
      });
    var x = new XMLHttpRequest();
    x.open("POST", "/api/echo?click=" + clicks);
    x.onload = function () {
      show("xhr", x.responseText + "/" + x.status);
      settle(parts);
    };
    x.send("echo " + clicks);
  } // end of onGo

  document.getElementById("go").addEventListener("click", onGo);
  document.getElementById("name").addEventListener("input", function (ev) {
    show("name", ev.target.value.toUpperCase());
  });
})();
