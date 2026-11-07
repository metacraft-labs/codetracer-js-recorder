// The text-input fixture as a plain page (no framework): see FIXTURES.
import { fx } from "../../fixture-dom.js";

const name = fx("name") as HTMLInputElement;
name.addEventListener("input", () => {
  performance.now();
  fx("echo").textContent = name.value.toUpperCase();
});
