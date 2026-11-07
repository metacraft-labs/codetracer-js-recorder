// The module tests/boundary/fixtures/resources.js imports dynamically: it
// reads the clock while it evaluates (before the import settles) and says
// so in the document.
var at = Date.now();
document
  .getElementById("out")
  .insertAdjacentHTML(
    "beforeend",
    '<li id="r-module">module=' + (at > 0) + "</li>",
  );
export const value = 7;
