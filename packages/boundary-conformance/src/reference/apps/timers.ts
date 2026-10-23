// The timers fixture on the reference framework: see FIXTURES.
import { fx } from "../../fixture-dom.js";
import { ref } from "../api.js";

const ticks = ref.state(0);
ref.on(fx("start"), "click", () => {
  const started = ref.now();
  ref.setTimeout(() => {
    ref.raf(() => {
      const handle = ref.setInterval(() => {
        ticks.set(ticks.get() + 1);
        const now = ref.now();
        fx("ticks").textContent = String(ticks.get());
        fx("ticks").setAttribute("data-elapsed", String(now - started));
        if (ticks.get() === 8) ref.clearInterval(handle);
      }, 300);
    });
  }, 50);
});
