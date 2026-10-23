// The prehydration fixture as a plain page (no framework): see FIXTURES.
// The page's inline <head> script queues clicks in `__fxQueue` until the
// page sets `__fxHydrated`; this script hydrates once the gate answers and
// replays the queue into the handler, as a framework's hydration would.
import { fx } from "../../fixture-dom.js";
import { ROUTES } from "../../protocol.js";

interface QueueWindow {
  __fxQueue: Event[];
  __fxHydrated: boolean;
}

let clicks = 0;
const early = fx("early");
function onClick(): void {
  clicks += 1;
  const at = Date.now();
  fx("clicks").textContent = String(clicks);
  fx("clicks").setAttribute("data-at", String(at));
}
void fetch(ROUTES.hydrateGate)
  .then((r) => r.text())
  .then(() => {
    const w = window as unknown as QueueWindow;
    early.addEventListener("click", onClick);
    w.__fxHydrated = true;
    const queued = w.__fxQueue;
    w.__fxQueue = [];
    for (const ev of queued) {
      if (ev.target instanceof Node && early.contains(ev.target)) onClick();
    }
  });
