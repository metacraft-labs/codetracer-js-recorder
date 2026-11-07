// The counter fixture on the reference framework: see FIXTURES.
import { fx } from "../../fixture-dom.js";
import { ref } from "../api.js";

const count = ref.state(Number(ref.storageGet("ct-fixture-count") ?? "0"));
fx("count").textContent = String(count.get());
ref.on(fx("inc"), "click", () => {
  count.set(count.get() + 1);
  const at = ref.now();
  fx("count").textContent = String(count.get());
  fx("count").setAttribute("data-at", String(at));
});
