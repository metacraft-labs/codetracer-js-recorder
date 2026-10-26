// A page task that runs while the document may still be parsed, and changes
// the document where the parser inserts: in a timer set by the document's
// one external script, it appends an element to the body. Whether the
// parser had inserted the text (and the comment) after the script by then
// decides which side of that text the element lands on, so a replay must
// release the timer where the parser was on record, text included
// (JS-Boundary-Recording §6, "The position"). With a `<textarea id="area">`
// in the document, the timer also notes how much of its text the parser had
// inserted. Once the document has loaded, a later task writes what followed
// the element into `#out` and sets `<body data-done="1">`.
"use strict";
(function () {
  var out = document.getElementById("out");
  function slot(text) {
    var li = document.createElement("li");
    li.textContent = text;
    out.appendChild(li);
  }
  function kind(node) {
    if (node === null) return "nothing";
    if (node.nodeType === 3) return "text";
    return node.nodeName.toLowerCase();
  }
  // `?timer=<ms>`: how long the first timer waits (default 0).
  var wait = Number(new URLSearchParams(location.search).get("timer")) || 0;
  setTimeout(function () {
    var late = document.createElement("p");
    late.id = "late";
    late.textContent = "late";
    document.body.appendChild(late);
    var area = document.getElementById("area");
    var seen = area === null ? -1 : area.value.length;
    // Once the document has loaded (the parser inserted all of it), and
    // at least 600 ms after this timer.
    setTimeout(function finish() {
      if (document.readyState !== "complete") {
        window.addEventListener("load", finish);
        return;
      }
      slot("followed by " + kind(late.nextSibling));
      if (area !== null) slot("area " + seen + " of " + area.value.length);
      document.body.setAttribute("data-done", "1");
    }, 600);
  }, wait);
})();
