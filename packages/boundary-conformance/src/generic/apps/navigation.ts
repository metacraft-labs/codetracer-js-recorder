// The navigation fixture as a plain page (no framework): see FIXTURES.
import { fx } from "../../fixture-dom.js";

function show(view: string): void {
  fx("view").textContent = view;
}
for (const [link, view] of [
  ["nav-about", "about"],
  ["nav-home", "home"],
] as const) {
  fx(link).addEventListener("click", (ev) => {
    ev.preventDefault();
    history.pushState(null, "", `?view=${view}`);
    show(view);
  });
}
window.addEventListener("popstate", () => {
  show(new URLSearchParams(location.search).get("view") ?? "home");
});
