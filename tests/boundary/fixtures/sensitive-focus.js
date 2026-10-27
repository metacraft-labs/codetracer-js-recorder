// Sensitive fields whose page moves focus away between a key's `keydown`
// and its `keyup`, as PIN and one-time-code widgets do: the browser
// dispatches the rest of that keystroke (its `keypress` when the keydown
// did not cancel it, and its `keyup`) at the element focused by then.
// Recorded by tests/boundary/sensitive.test.ts on both routes.
//
// - `pinA`: its keydown handler cancels the fourth key and focuses
//   `pubA`, a field the page declared public;
// - `pinB`: on the fourth key its keydown handler focuses `btn`, an
//   element that is not a field (the key is not cancelled);
// - `pinC`: on the fourth key its keydown handler blurs the field, leaving
//   nothing focused (the rest of the keystroke goes to `body`);
// - `otp`: a one-time-code field with a `maxlength` of 4, auto-advanced
//   by its `input` handler to `pubD`, a public field, on its fourth input;
// - `pinE`: on the fourth key its keydown handler focuses `pubE`, a public
//   field, without cancelling the key, so the browser inserts the key's
//   character into `pubE`;
// - `pinF`: like `pinA`, into `pubF`, for a key held down until it
//   repeats there (a repeated keydown is not cancelled, so its character
//   goes into `pubF`);
// - `ime`: an undeclared text field (sensitive by default) typed into
//   through an input method, whose keydowns are `Process`;
// - `pub`: a public field, typed into as the tests' vacuity guard.
//
// The handlers count events rather than read keys or values, so the page
// reads nothing sensitive (which replay would report as a raw read) and the
// tests type four digits into each PIN field; only `send` reads `pubE`.
//
// Every keyup is counted into `status` (the shape of the typing, not its
// content). The page's query names the case:
//
// - (none): `send` shows the count and finishes;
// - keybranch: a keyup at `pubA` branches on its `key`: a digit reads
//   `Math.random()` and shows it. On replay that key is masked, so the read
//   is missing there;
// - insert: `send` requests `/api/data` with `pubE`'s value in the query,
//   then shows the count and finishes;
// - insertbranch: `send` branches on `pubE`'s value: one that starts with
//   a digit reads `Math.random()`. On replay the field holds a placeholder,
//   so the read is missing there.
(function () {
  var kase = new URLSearchParams(location.search).get("case");
  var $ = function (id) {
    return document.getElementById(id);
  };
  // Calls `last` on the fourth `type` event at the field `id`.
  var onFourth = function (id, type, last) {
    var n = 0;
    $(id).addEventListener(type, function (e) {
      if (++n === 4) last.call(this, e);
    });
  };
  onFourth("pinA", "keydown", function (e) {
    e.preventDefault();
    $("pubA").focus();
  });
  onFourth("pinB", "keydown", function () {
    $("btn").focus();
  });
  onFourth("pinC", "keydown", function () {
    this.blur();
  });
  onFourth("otp", "input", function () {
    $("pubD").focus();
  });
  onFourth("pinE", "keydown", function () {
    $("pubE").focus();
  });
  onFourth("pinF", "keydown", function (e) {
    e.preventDefault();
    $("pubF").focus();
  });
  $("pubA").addEventListener("keyup", function (e) {
    if (kase === "keybranch" && /^[0-9]$/.test(e.key)) {
      $("status").textContent = "rolled " + Math.random();
    }
  });
  var keyups = 0;
  window.addEventListener("keyup", function () {
    keyups++;
    if (kase !== "keybranch") $("status").textContent = "keyups " + keyups;
  });
  var done = function () {
    document.body.setAttribute("data-done", "1");
  };
  $("send").addEventListener("click", function () {
    if (kase === "insert") {
      fetch("/api/data?q=" + encodeURIComponent($("pubE").value)).then(
        function () {
          $("status").textContent = "sent " + keyups;
          done();
        },
      );
      return;
    }
    if (kase === "insertbranch") {
      if (/^[0-9]/.test($("pubE").value)) Math.random();
      $("status").textContent = "went";
    } else if (kase !== "keybranch") {
      $("status").textContent = "sent " + keyups;
    }
    done();
  });
})();
