// The client-nodes fixture as a plain page (no framework): see FIXTURES.
import { fx } from "../../fixture-dom.js";

let rows = 0;
let done = 0;
fx("add").addEventListener("click", () => {
  rows += 1;
  const n = rows;
  const label = Math.random().toFixed(6);
  const li = document.createElement("li");
  li.textContent = `row ${n} ${label} `;
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("data-fx", `row-done-${n}`);
  button.textContent = "done";
  button.addEventListener("click", () => {
    li.classList.add("done");
    done += 1;
    fx("done-count").textContent = String(done);
  });
  li.append(button);
  fx("rows").append(li);
});
