// The sensitive-email fixture on the reference framework: see FIXTURES.
// `email` is undeclared, so the framework treats it as sensitive, as the
// generic shim does (§9.2's recommendation, §11.3.1).
import { fx } from "../../fixture-dom.js";
import { emailKind } from "../../sensitive-logic.js";
import { ref } from "../api.js";

const note = ref.state("");
const emailEl = fx("email") as HTMLInputElement;
const noteEl = fx("note") as HTMLInputElement;
ref.public(noteEl);
const kindOf = ref.declassify(
  (el: HTMLInputElement) => emailKind(el.value),
  "emailKind",
);
ref.on(emailEl, "input", () => {
  fx("verdict").textContent =
    kindOf(emailEl) === "invalid" ? "invalid" : "valid";
});
ref.on(noteEl, "input", () => note.set(noteEl.value));
