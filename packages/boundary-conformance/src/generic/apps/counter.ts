// The counter fixture as a plain page (no framework): see FIXTURES.
import { fx } from "../../fixture-dom.js";

let count = Number(localStorage.getItem("ct-fixture-count") ?? "0");
fx("count").textContent = String(count);
fx("inc").addEventListener("click", () => {
  count += 1;
  const at = Date.now();
  fx("count").textContent = String(count);
  fx("count").setAttribute("data-at", String(at));
});
