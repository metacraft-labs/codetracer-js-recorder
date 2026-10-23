// The text-input fixture on the reference framework: see FIXTURES.
import { fx } from "../../fixture-dom.js";
import { ref } from "../api.js";

const name = fx("name") as HTMLInputElement;
const value = ref.state("");
ref.on(name, "input", () => {
  ref.perfNow();
  value.set(name.value);
  fx("echo").textContent = value.get().toUpperCase();
});
