// The fixture page of tests/boundary/seeking.test.ts's range test across a
// suspended frame (CodeTracer's JS-Boundary-Recording specification §12).
//
// As in seeking.js, each click on #go makes more than 256 boundary reads
// (Math.random), so a checkpoint comes at the start of the next task: every
// click is followed by one. Clicks ASYNC_CLICKS are handled by an `async`
// function that awaits the click's fetch, so the checkpoint after each of
// them falls while that function is suspended at its `await`: no page code
// is on the stack there, but the instrumented build has entered the function
// and not returned from it. The other clicks are handled synchronously, so
// the checkpoints after them have no frame open.
//
// The page counts finished clicks in `data-finished` and sets
// `data-done="1"` after the last one, for the test to wait on.
(function () {
  var CLICKS = 6;
  var ASYNC_CLICKS = [1, 4];
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

  function begin() {
    clicks += 1;
    var parts = { left: 2 };
    var sum = 0;
    for (var i = 0; i < 260; i++) sum += Math.random();
    show("sum", sum.toFixed(6));
    document.getElementById("count").textContent = String(clicks);
    setTimeout(function () {
      show("timeout", Date.now());
      settle(parts);
    }, 5);
    return parts;
  }

  async function onGoAsync(parts) {
    var resp = await fetch("/api/data?click=" + clicks);
    var j = await resp.json();
    show("fetch", j.value + "/" + clicks);
    settle(parts);
  }

  function onGo() {
    var parts = begin();
    if (ASYNC_CLICKS.indexOf(clicks) >= 0) {
      onGoAsync(parts);
      return;
    }
    fetch("/api/data?click=" + clicks)
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        show("fetch", j.value + "/" + clicks);
        settle(parts);
      });
  }

  document.getElementById("go").addEventListener("click", onGo);
})();
