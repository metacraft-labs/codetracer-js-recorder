// The sensitive-pin fixture on the reference framework: see FIXTURES. The
// handler looks only at whether the key is the named key `Enter`.
import { fx } from "../../fixture-dom.js";
import { characterClasses } from "../../sensitive-logic.js";
import { ref } from "../api.js";

const label = ref.state("");
const pinEl = fx("pin") as HTMLInputElement;
const labelEl = fx("label") as HTMLInputElement;
ref.sensitive(pinEl);
ref.public(labelEl);
const pinShape = ref.declassify(
  (el: HTMLInputElement) => characterClasses(el.value),
  "pinShape",
);
ref.on(pinEl, "keydown", (ev) => {
  if ((ev as KeyboardEvent).key !== "Enter") return;
  pinShape(pinEl);
  fx("pin-state").textContent = "entered";
});
ref.on(labelEl, "input", () => label.set(labelEl.value));
