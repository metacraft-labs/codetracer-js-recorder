// The listeners of slow-load-quiet.html: slow-load.js without the reads that
// log a record. Its notes read the document's extent and readyState, which
// the replay answers from the document it has (no record), and no timer or
// clock is read, so the page runs nothing between one input and the next. A
// replay that ran an input at another point of the document's parsing than
// the log's diverges at the next checkpoint, where the notes are written.
var notes = [];
function extent() {
  var own = document.querySelectorAll("script[data-codetracer-boundary-shim]");
  return document.getElementsByTagName("*").length - own.length;
}
function note(label) {
  notes.push(label + "@" + extent() + "/" + document.readyState);
}
document.addEventListener("pointermove", function () {
  note("move");
});
document.addEventListener("mouseover", function (e) {
  note("over:" + e.target.localName);
});
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
