// Text fields in closed shadow roots the HTML parser attached (declarative
// shadow DOM, `<template shadowrootmode="closed">`), whose hosts are
// focusable themselves: no call the shim can see made those roots, so the
// window's listeners see the keystrokes into the fields at the hosts.
// Recorded by tests/boundary/sensitive.test.ts on both routes.
//
// - `dhost`: a `div` with a `tabindex`, its field focused by a click;
// - `dfhost`: a custom element with a `tabindex` whose root delegates focus,
//   its field focused by `focus()` on the host. Its class reaches the
//   closed root the way a component does, through its `ElementInternals`,
//   and exposes the field's value as `secretValue`;
// - `item`: a focusable list item, which cannot host a shadow root (the
//   control: its keys are its own);
// - `kneg`, `kpub`, `kct`: focusable widgets with no shadow root that
//   take their own keys: `kneg` is unmarked, so it is taken for the host
//   of a root the shim cannot see; `kpub` carries `data-ct-public` and
//   `kct` is declared public by `ct.public`, so their keys are exact.
//
// Every keydown at a host is counted into `status` (the shape of the
// typing, not its content). The page's query names the case:
//
// - upload: `send` fetches a URL carrying `dfhost`'s field's value;
// - replay: `send` reads nothing sensitive, so the replay, which cannot
//   put text into a field behind a closed root, has the same request;
// - keybranch: a keydown at a widget branches on its `key`: `g` reads
//   `Math.random()` and shows it, any other key does nothing. On replay the
//   unmarked widget's key is masked, so the read is missing there.
(function () {
  var kase = new URLSearchParams(location.search).get("case");
  var $ = function (id) {
    return document.getElementById(id);
  };
  customElements.define(
    "x-dfocus",
    class extends HTMLElement {
      constructor() {
        super();
        this._internals = this.attachInternals();
      }
      get secretValue() {
        return this._internals.shadowRoot.querySelector("input").value;
      }
    },
  );
  ct.public($("kct"));
  ["kneg", "kpub", "kct"].forEach(function (id) {
    $(id).addEventListener("keydown", function (e) {
      if (kase !== "keybranch") return;
      if (e.key === "g") {
        $("status").textContent = id + " rolled " + Math.random();
      }
    });
  });
  var keys = 0;
  ["dhost", "dfhost"].forEach(function (id) {
    $(id).addEventListener("keydown", function () {
      keys++;
      $("status").textContent = "keys " + keys;
    });
  });
  $("send").addEventListener("click", function () {
    var finish = function () {
      document.body.setAttribute("data-done", "1");
    };
    if (kase === "upload") {
      fetch("/api/data?d=" + encodeURIComponent($("dfhost").secretValue)).then(
        finish,
      );
    } else {
      $("status").textContent = "sent " + keys;
      finish();
    }
  });
})();
