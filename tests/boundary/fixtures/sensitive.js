// Sensitive inputs (CodeTracer's JS-Boundary-Recording specification
// §11.3), recorded and replayed by tests/boundary/sensitive.test.ts. The
// page's query names the case:
//
// - email: a click on `check` branches on a declassifier of the e-mail
//   field (`isValidEmail`), which counts its own runs; `finish` reports the
//   count by an error raised in a timer, whose message the log holds as a
//   template (the count hidden), so a replay that raises it with another
//   count matches, and the runner's report carries the raw message;
// - login: a click on `login` sends the password in a request's query and
//   JSON body (the network seam is the sanctioned sink, §11.3.1);
// - branch: a click on `go` branches on the first character of the
//   undeclared (so sensitive) `pin` field's raw value, a read outside a
//   declassifier, and reads `Math.random()` only on one branch;
// - roll: a click on `roll` shows `Math.random()`; nothing sensitive is read;
// - mirror: an undeclared text field whose value the page mirrors into its
//   `value` attribute, and a `textarea` whose value it mirrors into its
//   default value (its text), as frameworks keep controlled fields, under a
//   `MutationObserver` with old values; and the undeclared `contenteditable`
//   region `ed`.
(function () {
  var kase = new URLSearchParams(location.search).get("case");
  var $ = function (id) {
    return document.getElementById(id);
  };
  var done = function () {
    document.body.setAttribute("data-done", "1");
  };
  var calls = 0;
  var isValidEmail = ct.declassify(
    function isValidEmail(el) {
      calls++;
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(el.value);
    },
    { id: "isValidEmail" },
  );
  // The record side's count, read by the test before the session stops.
  window.__declassifierCalls = function () {
    return calls;
  };
  $("check").addEventListener("click", function () {
    if (kase !== "email") return;
    $("verdict").textContent = isValidEmail($("email")) ? "valid" : "invalid";
  });
  $("login").addEventListener("click", function () {
    if (kase !== "login") return;
    var pw = $("pw").value;
    fetch("/api/data?pin=" + encodeURIComponent(pw), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "ada", pass: pw }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        $("status").textContent = "logged in " + j.value;
        done();
      });
  });
  $("go").addEventListener("click", function () {
    if (kase !== "branch") return;
    if ($("pin").value[0] === "7") Math.random();
    $("status").textContent = "went";
  });
  $("roll").addEventListener("click", function () {
    if (kase !== "roll") return;
    $("status").textContent = String(Math.random());
  });
  if (kase === "mirror") {
    var mir = $("mir");
    mir.addEventListener("input", function () {
      mir.setAttribute("value", mir.value);
    });
    var ta = $("ta");
    ta.addEventListener("input", function () {
      ta.defaultValue = ta.value;
    });
    new MutationObserver(function (records) {
      $("status").textContent = records.length + " mutations";
    }).observe($("mirrors"), {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeOldValue: true,
    });
  }
  $("finish").addEventListener("click", function () {
    if (kase === "email") {
      setTimeout(function () {
        done();
        throw new Error("declassifier-calls=" + calls);
      }, 0);
      return;
    }
    done();
  });
})();
