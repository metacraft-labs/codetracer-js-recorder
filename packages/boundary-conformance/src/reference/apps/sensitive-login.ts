// The sensitive-login fixture on the reference framework: see FIXTURES. The
// framework declares `user` public and keeps the password in a sensitive
// signal, which its checkpoint hash leaves out (§9.6).
import { fx } from "../../fixture-dom.js";
import { ROUTES } from "../../protocol.js";
import { characterClasses, LEAK_RAW_READ } from "../../sensitive-logic.js";
import { ref } from "../api.js";

const user = ref.state("");
const pass = ref.secret("");
const userEl = fx("user") as HTMLInputElement;
const passEl = fx("pass") as HTMLInputElement;
ref.public(userEl);
const passwordStrength = ref.declassify(
  (p: { get(): string }) => characterClasses(p.get()),
  "passwordStrength",
);
ref.on(userEl, "input", () => user.set(userEl.value));
ref.on(passEl, "input", () => pass.set(passEl.value));
ref.on(fx("form"), "submit", (ev) => {
  ev.preventDefault();
  if (LEAK_RAW_READ) {
    // The non-interference falsifier: a raw read of the sensitive signal
    // outside a declassifier that changes what the page sends (§11.3.6).
    void ref.fetchText(
      "GET",
      `${ROUTES.items}?first=${pass.get()[0] === "A" ? "a" : "b"}`,
    );
  }
  if (passwordStrength(pass) < 2) {
    fx("status").textContent = "too weak";
    return;
  }
  // The framework's network seam is the sanctioned sink (§11.3.1).
  void ref
    .fetchText(
      "POST",
      ROUTES.login,
      JSON.stringify({ user: user.get(), pass: pass.get() }),
    )
    .then((text) => {
      const j = JSON.parse(text) as { user: string };
      fx("status").textContent = `welcome ${j.user}`;
    });
});
