// A text field in a closed shadow root the HTML parser attached to `body`
// itself (declarative shadow DOM, `<template shadowrootmode="closed">` as
// body's first child): the window's listeners see the keystrokes into the
// field at `body`, the target of every keystroke made while nothing has
// focus. Recorded by tests/boundary/sensitive.test.ts on both routes.
//
// The field sits at the top left of the viewport and is focused by a click
// there; the page's own content is slotted below it. A click on `blank`
// leaves nothing focused, and a key then pressed is the page's own (the
// control: a page's shortcuts at `body` are kept).
//
// Every keydown at `body` is counted into `status` (the shape of the typing,
// not its content); `send` shows the count and finishes.
(function () {
  var $ = function (id) {
    return document.getElementById(id);
  };
  var keys = 0;
  document.body.addEventListener("keydown", function (e) {
    if (e.target !== document.body) return;
    keys++;
    $("status").textContent = "keys " + keys;
  });
  $("send").addEventListener("click", function () {
    $("status").textContent = "sent " + keys;
    document.body.setAttribute("data-done", "1");
  });
})();
