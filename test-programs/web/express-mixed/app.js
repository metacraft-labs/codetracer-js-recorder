// Real Express handlers. The injected callback is the recorded HTTP client's
// event-loop turn, not a mock; awaiting it forces client/server interleaving.
const express = require("express");
const { codetracerExpress } = require("@codetracer/express");
function buildApp(clientTurn) {
  const app = express();
  app.use(codetracerExpress());
  app.get("/alpha", async (_req, res) => {
    await clientTurn("alpha");
    res.json({ handler: "alpha" });
  });
  app.get("/beta", async (_req, res) => {
    await clientTurn("beta");
    res.status(201).json({ handler: "beta" });
  });
  return app;
}
module.exports = { buildApp };
