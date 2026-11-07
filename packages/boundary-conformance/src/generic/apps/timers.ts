// The timers fixture as a plain page (no framework): see FIXTURES.
import { fx } from "../../fixture-dom.js";

fx("start").addEventListener("click", () => {
  const started = Date.now();
  setTimeout(() => {
    requestAnimationFrame(() => {
      let ticks = 0;
      const id = setInterval(() => {
        ticks += 1;
        const now = Date.now();
        fx("ticks").textContent = String(ticks);
        fx("ticks").setAttribute("data-elapsed", String(now - started));
        if (ticks === 8) clearInterval(id);
      }, 300);
    });
  }, 50);
});
