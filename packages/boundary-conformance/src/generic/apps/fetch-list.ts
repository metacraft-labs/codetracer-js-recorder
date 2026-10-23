// The fetch-list fixture as a plain page (no framework): see FIXTURES.
import { fx } from "../../fixture-dom.js";
import { ROUTES } from "../../protocol.js";

let loads = 0;
function load(): void {
  void fetch(ROUTES.items)
    .then((r) => r.json())
    .then((items: { name: string }[]) => {
      const list = fx("list");
      list.replaceChildren(
        ...items.map((it) => {
          const li = document.createElement("li");
          li.textContent = it.name;
          return li;
        }),
      );
      const height = list.getBoundingClientRect().height;
      list.setAttribute("data-height", String(Math.round(height)));
      loads += 1;
      fx("loads").textContent = String(loads);
      fx("summary").textContent = `${items.length} items`;
    });
}
fx("reload").addEventListener("click", load);
load();
