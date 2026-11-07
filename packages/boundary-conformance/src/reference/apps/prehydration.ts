// The prehydration fixture on the reference framework: see FIXTURES. The
// page is marked `data-ref-hydration="deferred"`, so the framework queues
// clicks until `hydrate` runs and then replays them into the handlers.
import { fx } from "../../fixture-dom.js";
import { ROUTES } from "../../protocol.js";
import { ref } from "../api.js";

const clicks = ref.state(0);
void ref.fetchText("GET", ROUTES.hydrateGate).then(() => {
  ref.hydrate(() => {
    ref.on(fx("early"), "click", () => {
      clicks.set(clicks.get() + 1);
      const at = ref.now();
      fx("clicks").textContent = String(clicks.get());
      fx("clicks").setAttribute("data-at", String(at));
    });
  });
});
