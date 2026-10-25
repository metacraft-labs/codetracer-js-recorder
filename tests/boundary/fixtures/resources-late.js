// A script the page inserts that arrives after the session ended: it never
// ran while the page was recorded, so it must not run on replay either.
document
  .getElementById("out")
  .insertAdjacentHTML("beforeend", '<li id="r-late">late ran</li>');
