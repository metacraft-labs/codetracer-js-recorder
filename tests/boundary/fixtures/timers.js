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
  var violations = 0;
  document.addEventListener("securitypolicyviolation", function () {
    violations++;
  });
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

  setTimeout(function () {
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
  }, 300);
})();
