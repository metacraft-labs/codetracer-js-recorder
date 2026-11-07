// The fixture page of tests/boundary/record-shim.test.ts: one click on #go
// makes at least one read of every boundary kind the generic shim logs, and
// writes each result into its own fixed slot, so the final DOM does not
// depend on the order in which the asynchronous reads complete.
//
// `window.__pageCounts` is the page's own count of its reads, kept by
// counting-layer.js through references captured before the shim loaded.
// Counting starts here, at the page's first statement, so the reads the
// recorder makes while installing itself are not counted as the page's;
// for the same reason the seeded random source of the behaviour comparison
// (seeded-random.js) restarts here.
(function () {
  if (window.__pageCounts) window.__pageCounts.enabled = true;
  if (window.__seedRandom) window.__seedRandom();
  window.__errors = { error: 0, rejection: 0 };
  window.addEventListener("error", function () {
    window.__errors.error++;
  });
  window.addEventListener("unhandledrejection", function () {
    window.__errors.rejection++;
  });

  function show(label, value) {
    document.getElementById("r-" + label).textContent = label + "=" + value;
  }

  var pending = 0;
  function begin() {
    pending++;
  }
  function finish() {
    pending--;
    if (pending === 0) document.body.setAttribute("data-done", "1");
  }

  document.getElementById("go").addEventListener("click", function (ev) {
    // An event's timeStamp is a clock read (Clock src 5), of the browser's
    // input event and of an event the page makes itself.
    var stamps = [ev.timeStamp, new Event("made").timeStamp];
    window.__stamps = stamps;
    show("stamp", [typeof stamps[0], typeof stamps[1]].join(","));
    show("now", Date.now());
    show("perf", Math.round(performance.now()));
    show("rand", Math.random());
    var bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    show("bytes", Array.prototype.join.call(bytes, ","));
    localStorage.setItem("k", "v1");
    show("ls", localStorage.getItem("k"));
    show("ls-miss", String(localStorage.getItem("missing")));
    var rect = document.getElementById("box").getBoundingClientRect();
    show("rect", rect.width + "x" + rect.height);

    begin();
    setTimeout(function () {
      show("timeout", Date.now());
      finish();
    }, 10);

    begin();
    var ticks = 0;
    var interval = setInterval(function () {
      ticks++;
      show("tick", ticks);
      if (ticks === 2) {
        clearInterval(interval);
        finish();
      }
    }, 5);

    begin();
    requestAnimationFrame(function (ts) {
      show("raf", typeof ts);
      finish();
    });

    begin();
    fetch("/api/data?x=1")
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        show("fetch", j.value);
        finish();
      });

    // The constructors the shim replaces behave as the platform's: a
    // subclass keeps its prototype, and a call without `new` throws.
    class SubXhr extends XMLHttpRequest {
      sub() {
        return "sub";
      }
    }
    var sub = new SubXhr();
    var called;
    try {
      XMLHttpRequest();
      called = "returned";
    } catch (e) {
      called = e.name;
    }
    show(
      "xhrctor",
      (sub instanceof SubXhr ? sub.sub() : "lost") + "," + called,
    );

    begin();
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/echo");
    xhr.onload = function () {
      show("xhr", xhr.responseText);
      finish();
    };
    xhr.send("hello");
  });
})();
