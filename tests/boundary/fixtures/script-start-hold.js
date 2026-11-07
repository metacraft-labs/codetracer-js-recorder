// A parser-blocking script the fixture server answers late
// (`script-start-async.html`), so the parser waits for it while the async
// `script-start.js` runs. It makes no boundary read.
"use strict";
document.documentElement.setAttribute("data-held", "1");
