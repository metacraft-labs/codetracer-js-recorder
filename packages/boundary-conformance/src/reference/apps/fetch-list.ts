// The fetch-list fixture on the reference framework: see FIXTURES.
import { fx } from "../../fixture-dom.js";
import { ROUTES } from "../../protocol.js";
import { ref } from "../api.js";

const loads = ref.state(0);
function load(): void {
  void ref.fetchText("GET", ROUTES.items).then((text) => {
    const items = JSON.parse(text) as { name: string }[];
    const list = fx("list");
    list.replaceChildren(
      ...items.map((it) => {
        const li = document.createElement("li");
        li.textContent = it.name;
        return li;
      }),
    );
    const height = ref.rect(list).height;
    list.setAttribute("data-height", String(Math.round(height)));
    loads.set(loads.get() + 1);
    fx("loads").textContent = String(loads.get());
    fx("summary").textContent = `${items.length} items`;
  });
}
ref.on(fx("reload"), "click", load);
load();
