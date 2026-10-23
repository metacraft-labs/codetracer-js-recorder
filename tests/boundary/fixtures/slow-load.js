// The listeners of slow-load.html. Each notes what it saw: the document's
// extent (its element count; the gate scripts of a replay are never in it),
// its readyState, and a boundary read. At load the notes are written into
// the document, where the session's last checkpoint (dom-v1) covers them: a
// replay that ran any of these at another point of the document's loading
// diverges there.
var notes = [];
function extent() {
  // The recording's bootstrap script is the shim's, and replay installs
  // the shim without one; every other element counts.
  var own = document.querySelectorAll("script[data-codetracer-boundary-shim]");
  return document.getElementsByTagName("*").length - own.length;
}
function note(label) {
  notes.push(
    label +
      "@" +
      extent() +
      "/" +
      document.readyState +
      "/" +
      Math.floor(performance.now() % 7),
  );
}
document.addEventListener("pointermove", function () {
  note("move");
});
document.addEventListener("mouseover", function (e) {
  note("over:" + e.target.localName + ":" + (Date.now() % 3));
});
setTimeout(function () {
  note("timer-0");
}, 0);
setTimeout(function () {
  note("timer-200");
}, 200);
document.addEventListener("readystatechange", function () {
  note("state");
});
document.addEventListener("DOMContentLoaded", function () {
  note("dcl");
});
window.addEventListener("load", function () {
  note("load");
  document.body.setAttribute("data-notes", notes.join(" "));
  document.body.setAttribute("data-loaded", "1");
});
