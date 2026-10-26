// The sensitive-pin fixture as a plain page (no framework): see FIXTURES.
// `pin` carries `data-ct-sensitive`; its handler looks only at whether the
// key is the named key `Enter` (§11.3.3: named keys are recorded verbatim).
import { fx } from "../../fixture-dom.js";
import { characterClasses } from "../../sensitive-logic.js";
import { ct } from "../ct.js";

const state = { label: "" };
const pin = fx("pin") as HTMLInputElement;
const label = fx("label") as HTMLInputElement;
const pinShape = ct.declassify(
  (el: HTMLInputElement) => characterClasses(el.value),
  { id: "pinShape" },
);
pin.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  pinShape(pin);
  fx("pin-state").textContent = "entered";
});
label.addEventListener("input", () => {
  state.label = label.value;
});
