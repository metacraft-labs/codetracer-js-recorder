// The client-nodes fixture on the reference framework: see FIXTURES. Rows
// and their buttons are created through the framework, which addresses
// them by creation ordinal (`ord:`).
import { fx } from "../../fixture-dom.js";
import { ref } from "../api.js";

const rows = ref.state(0);
const done = ref.state(0);
ref.on(fx("add"), "click", () => {
  rows.set(rows.get() + 1);
  const n = rows.get();
  const label = ref.random().toFixed(6);
  const li = ref.create("li");
  li.textContent = `row ${n} ${label} `;
  const button = ref.create("button");
  button.type = "button";
  button.setAttribute("data-fx", `row-done-${n}`);
  button.textContent = "done";
  ref.on(button, "click", () => {
    li.classList.add("done");
    done.set(done.get() + 1);
    fx("done-count").textContent = String(done.get());
  });
  li.append(button);
  fx("rows").append(li);
});
