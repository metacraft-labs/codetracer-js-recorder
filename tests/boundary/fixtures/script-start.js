// An external script whose first boundary read comes after it changed the
// document, as an application shell renders and then reads the clock or
// starts observing: it inserts two elements (and their text) into `#host`,
// and only then constructs a `MutationObserver` (its first boundary record)
// and reads the clock. The recorder writes the script's execution and the
// document's position before that first record, so the position counts what
// the script inserted; a replay must still be able to run the script there.
// Once the document has loaded, a later task writes what the page saw into
// `#out` and sets `<body data-done="1">`.
//
// `script-start-quiet.html` sets `window.scriptStartQuiet` from a storage
// read made before this script runs; when it is true the script changes the
// document and stops, writing no record at all (a replay whose log has it
// write one must diverge).
"use strict";
(function () {
  var host = document.getElementById("host");
  var out = document.getElementById("out");
  function slot(text) {
    var li = document.createElement("li");
    li.textContent = text;
    out.appendChild(li);
  }
  var title = document.createElement("h2");
  title.textContent = "rendered by the script";
  host.appendChild(title);
  var list = document.createElement("ol");
  host.appendChild(list);
  if (window.scriptStartQuiet === true) return;
  var observed = 0;
  new MutationObserver(function (records) {
    observed += records.length;
  }).observe(host, { childList: true, subtree: true });
  var started = Date.now();
  var item = document.createElement("li");
  item.textContent = "after the first read";
  list.appendChild(item);
  setTimeout(function finish() {
    if (document.readyState !== "complete") {
      window.addEventListener("load", finish);
      return;
    }
    slot("observed " + observed);
    slot("clock " + (typeof started === "number"));
    slot("after " + (document.getElementById("after") !== null));
    document.body.setAttribute("data-done", "1");
  }, 0);
})();
