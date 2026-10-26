// The sensitive-login fixture as a plain page (no framework): see FIXTURES.
// The page declares nothing in script: `user` carries `data-ct-public`, and
// the password is a credential field the shim recognises (§11.3.1).
import { fx } from "../../fixture-dom.js";
import { ROUTES } from "../../protocol.js";
import { characterClasses, LEAK_RAW_READ } from "../../sensitive-logic.js";
import { ct } from "../ct.js";

const state = { user: "" };
const user = fx("user") as HTMLInputElement;
const pass = fx("pass") as HTMLInputElement;
// The declassifier reads the value itself, inside its body (§11.3.2).
const passwordStrength = ct.declassify(
  (el: HTMLInputElement) => characterClasses(el.value),
  { id: "passwordStrength" },
);
user.addEventListener("input", () => {
  state.user = user.value;
});
pass.addEventListener("input", () => {
  // Nothing of the password is kept: the submit handler reads it.
});
fx("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (LEAK_RAW_READ) {
    // The non-interference falsifier: a raw read outside a declassifier
    // that changes what the page sends (§11.3.6).
    void fetch(`${ROUTES.items}?first=${pass.value[0] === "A" ? "a" : "b"}`);
  }
  if (passwordStrength(pass) < 2) {
    fx("status").textContent = "too weak";
    return;
  }
  // The network seam is the sanctioned sink (§11.3.1): the password goes
  // out, its holed form is logged (§5.2.1).
  void fetch(ROUTES.login, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: state.user, pass: pass.value }),
  })
    .then((r) => r.json())
    .then((j: { user: string }) => {
      fx("status").textContent = `welcome ${j.user}`;
    });
});
