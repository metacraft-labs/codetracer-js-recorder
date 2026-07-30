/**
 * Express demo app for the CodeTracer Request Panel (RS-M9).
 *
 * Every route is deterministic and every handler is short, so a request's
 * recorded step range is essentially the steps of its handler.  Between them
 * the routes cover each status bucket the Request Panel colours (2xx, 3xx,
 * 4xx, 5xx), two methods, a parameterised route, a handler that awaits (so a
 * span that genuinely crosses async contexts exists), and a handler that
 * throws (so a 500 span carries `error.message`).
 *
 * The span middleware is installed FIRST, before the body parser and the
 * router, so a span covers routing and error handling too and not merely the
 * handler body.
 */

"use strict";

const express = require("express");
const {
  codetracerExpress,
  codetracerExpressErrors,
} = require("@codetracer/express");

const USERS = {
  1: { id: 1, name: "Alice" },
  2: { id: 2, name: "Bob" },
};

/** Await-based sleep — the async boundary the milestone is about. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build the demo app, with the CodeTracer middleware already installed. */
function buildApp() {
  const app = express();

  // First in the pipeline: the span covers body parsing, routing, the
  // handler and the error path.
  app.use(codetracerExpress());
  app.use(express.json());

  app.get("/api/users", (req, res) => {
    const users = Object.values(USERS).sort((a, b) => a.id - b.id);
    res.json(users);
  });

  app.post("/api/users", (req, res) => {
    const payload = req.body || {};
    const nextId = Math.max(...Object.keys(USERS).map(Number)) + 1;
    USERS[nextId] = { id: nextId, name: payload.name || "anonymous" };
    res.status(201).json(USERS[nextId]);
  });

  app.get("/api/users/:userId", (req, res) => {
    const user = USERS[Number(req.params.userId)];
    if (user === undefined) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(user);
  });

  app.get("/static/app.css", (req, res) => {
    // A 3xx so the demo exercises every status bucket the panel colours.
    // 304 rather than a redirect: an HTTP client follows a redirect, which
    // would add a request the demo never asked for.
    res.status(304).end();
  });

  // THE async handler.  It awaits inside the span's step range, so its
  // continuation runs in a different Node async context — which the recorder
  // maps to a different container thread, and which is therefore visible in
  // the span's `contiguous_on_one_thread` bit.
  app.get("/api/reports/slow", async (req, res) => {
    const started = Date.now();
    await sleep(50);
    const rows = [1, 2, 3].map((n) => n * 2);
    res.json({ rows: rows, elapsedMs: Date.now() - started });
  });

  // THE error path.  The handler throws; the span's status becomes error and
  // its `error.message` is filled in by `codetracerExpressErrors`.
  app.get("/api/boom", (req, res) => {
    throw new Error("demo handler exploded");
  });

  // AFTER the routes, like any Express error handler: annotate the span, then
  // let the terminal handler below choose the status code.
  app.use(codetracerExpressErrors());

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: String(err && err.message) });
  });

  return app;
}

module.exports = { buildApp, sleep, USERS };
