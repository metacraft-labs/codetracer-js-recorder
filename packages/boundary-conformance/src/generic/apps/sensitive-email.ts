// The sensitive-email fixture as a plain page (no framework): see FIXTURES.
// `email` is undeclared, so the shim treats it as sensitive (§11.3.1).
import { fx } from "../../fixture-dom.js";
import { emailKind } from "../../sensitive-logic.js";
import { ct } from "../ct.js";

const state = { note: "" };
const email = fx("email") as HTMLInputElement;
const note = fx("note") as HTMLInputElement;
const kindOf = ct.declassify((el: HTMLInputElement) => emailKind(el.value), {
  id: "emailKind",
});
email.addEventListener("input", () => {
  fx("verdict").textContent = kindOf(email) === "invalid" ? "invalid" : "valid";
});
note.addEventListener("input", () => {
  state.note = note.value;
});
