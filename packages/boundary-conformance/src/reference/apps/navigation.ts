// The navigation fixture on the reference framework: see FIXTURES.
import { fx } from "../../fixture-dom.js";
import { ref } from "../api.js";

const view = ref.state("home");
function show(v: string): void {
  view.set(v);
  fx("view").textContent = v;
}
for (const [link, v] of [
  ["nav-about", "about"],
  ["nav-home", "home"],
] as const) {
  ref.on(fx(link), "click", (ev) => {
    ev.preventDefault();
    ref.pushState(`?view=${v}`);
    show(v);
  });
}
ref.onPopState(() => {
  show(new URLSearchParams(location.search).get("view") ?? "home");
});
