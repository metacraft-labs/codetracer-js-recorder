// What a level-0 page declares for its session's narrative (CodeTracer's
// JS-Boundary-Recording specification §9.4, §13), recorded and replayed by
// tests/boundary/declarations.test.ts: the arms on the document element
// (`data-ct-arms`, in declarations.html), labels on elements
// (`data-ct-label`), and marks (`ct.mark`).
//
// - `open` (a span inside a button inside a labelled div) marks the
//   exposure to the checkout experiment;
// - `pay` checks the e-mail field with a declassifier, which also tries to
//   mark inside its own body (never logged), then marks a conversion when
//   the address is valid, with data that quotes the field's raw value (holed
//   in the log);
// - every invalid `ct.mark` call throws, on record and on replay alike;
//   the page counts the throws and shows the count;
// - `finish` ends the case.
(function () {
  var $ = function (id) {
    return document.getElementById(id);
  };
  var refused = 0;
  var tryMark = function (name, data) {
    try {
      ct.mark(name, data);
    } catch (e) {
      if (e instanceof TypeError) refused++;
      else throw e;
    }
  };
  var isValidEmail = ct.declassify(
    function isValidEmail(el) {
      // A mark made inside a declassifier is part of its body: not logged.
      ct.mark("inside-declassifier", { value: el.value });
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(el.value);
    },
    { id: "isValidEmail" },
  );
  $("open").addEventListener("click", function () {
    ct.mark("exposure:checkout", { arm: "B", at: Date.now() > 0 });
    $("status").textContent = "cart";
  });
  $("pay").addEventListener("click", function () {
    if (isValidEmail($("email"))) {
      ct.mark("conversion:purchase", { quoted: "by " + $("email").value });
      $("status").textContent = "paid";
    } else {
      $("status").textContent = "invalid";
    }
  });
  $("plain").addEventListener("click", function () {
    tryMark("");
    tryMark("x".repeat(257));
    tryMark("bad-data", { f: function () {} });
    tryMark("too-long", "y".repeat(5000));
    tryMark("no-data");
    $("status").textContent = "refused " + refused;
  });
  $("finish").addEventListener("click", function () {
    document.body.setAttribute("data-done", "1");
  });
})();
