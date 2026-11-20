// The fixture page of the string-timer test in
// tests/boundary/record-shim-fidelity.test.ts, loaded by timers.html (no
// CSP) and timers-csp.html (a CSP without 'unsafe-eval').
//
// A timer handler that is not a function is compiled by the platform as a
// classic script in the global scope: a top-level `let` in one is a global
// lexical binding the next one sees, `this` is the window, and under a CSP
// without 'unsafe-eval' the platform refuses to compile it. The page writes
// what it observed into `r-results` once the timers have had their chance.
(function () {
  window.__errors = { error: 0, rejection: 0 };
  window.addEventListener("error", function () {
    window.__errors.error++;
  });
  window.addEventListener("unhandledrejection", function () {
    window.__errors.rejection++;
  });
  // The CSP violations the page's string timers cause (timers-csp.html states
  // how many it expects; a page without a CSP expects none).
  var violations = 0;
  var expectedViolations = Number(
    document.body.getAttribute("data-expect-violations") || "0",
  );
  var timerDone = false;
  var reported = false;
  var out = document.getElementById("out");
  function slot(name, value) {
    var li = document.getElementById("r-" + name);
    if (li === null) {
      li = document.createElement("li");
      li.id = "r-" + name;
      out.appendChild(li);
    }
    li.textContent = name + "=" + value;
  }

  var handles = [];
  handles.push(
    setTimeout("let z = 5; var gv = 1; window.__a = typeof z;", 0) > 0,
  );
  handles.push(
    setTimeout(
      "window.__b = [typeof z, typeof gv, this === window].join(',');",
      10,
    ) > 0,
  );
  handles.push(
    setTimeout(
      {
        toString: function () {
          return "window.__o = 'object handler';";
        },
      },
      15,
    ) > 0,
  );
  window.__ticks = 0;
  window.__iv = setInterval(
    "if (++window.__ticks === 2) clearInterval(window.__iv);",
    5,
  );
  handles.push(window.__iv > 0);

  // The report needs both: the 300 ms timer, which is due after the string
  // timers (same timer queue, so they have run), and every violation. A
  // violation is an event the platform queues in a task of its own, and a
  // timer that is due later can run before it under load (Chromium does not
  // keep due order across task queues), so the timer alone does not show
  // that the violations were counted. Without the violations the report
  // waits, and the test ends at its timeout instead of reading a count
  // that has not arrived.
  function reportWhenReady() {
    if (reported || !timerDone || violations < expectedViolations) return;
    reported = true;
    slot(
      "results",
      JSON.stringify([
        handles,
        String(window.__a),
        String(window.__b),
        String(window.__o),
        window.__ticks,
        window.__errors.error,
        violations,
      ]),
    );
    document.body.setAttribute("data-done", "1");
  }
  document.addEventListener("securitypolicyviolation", function () {
    violations++;
    reportWhenReady();
  });
  setTimeout(function () {
    timerDone = true;
    reportWhenReady();
  }, 300);
})();
