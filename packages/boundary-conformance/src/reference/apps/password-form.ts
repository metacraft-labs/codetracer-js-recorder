// The password-form fixture on the reference framework: see FIXTURES.
import { fx } from "../../fixture-dom.js";
import { ROUTES } from "../../protocol.js";
import { ref } from "../api.js";

const user = ref.state("");
const pass = ref.state("");
const userEl = fx("user") as HTMLInputElement;
const passEl = fx("pass") as HTMLInputElement;
ref.on(userEl, "input", () => user.set(userEl.value));
ref.on(passEl, "input", () => pass.set(passEl.value));
ref.on(fx("form"), "submit", (ev) => {
  ev.preventDefault();
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
