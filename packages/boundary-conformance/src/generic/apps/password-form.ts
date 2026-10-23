// The password-form fixture as a plain page (no framework): see FIXTURES.
import { fx } from "../../fixture-dom.js";
import { ROUTES } from "../../protocol.js";

const state = { user: "", pass: "" };
const user = fx("user") as HTMLInputElement;
const pass = fx("pass") as HTMLInputElement;
user.addEventListener("input", () => {
  state.user = user.value;
});
pass.addEventListener("input", () => {
  state.pass = pass.value;
});
fx("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  void fetch(ROUTES.login, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: state.user, pass: state.pass }),
  })
    .then((r) => r.json())
    .then((j: { user: string }) => {
      fx("status").textContent = `welcome ${j.user}`;
    });
});
