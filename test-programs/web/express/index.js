/**
 * Drive a recorded Express session (RS-M9) — shared by the tests and the demo.
 *
 * Everything here is real: a real Express app on a real `http.Server` bound to
 * loopback, real HTTP over TCP, a real `.ct` container whose span stream is
 * decoded by the canonical Nim span reader.  Nothing is stubbed.
 *
 * The driver lives in the same process as the server on purpose.  Node is
 * single-threaded, so "the client and the server share one event loop" is not
 * a simplification of the deployment model — it is the same event loop a
 * production Node server multiplexes its own concurrent requests on, and it is
 * exactly the thing this milestone has to get right.  Running the driver
 * out-of-process would need a port file, a signal, and a graceful-shutdown
 * dance, and would test less.
 *
 * Run it under the recorder:
 *
 *     codetracer-js-recorder record test-programs/web/express -o /tmp/ct-js
 *
 * Environment:
 *
 *   CT_EXPRESS_REQUESTS    JSON `[[method, path, body|null], ...]` schedule.
 *                          Defaults to `DEMO_REQUESTS` below.
 *   CT_EXPRESS_CONCURRENT  "1" fires the whole schedule at once, so the
 *                          handlers interleave on the event loop.  Anything
 *                          else (the default) awaits each response before
 *                          issuing the next.
 */

"use strict";

const http = require("node:http");
const { buildApp } = require("./app.js");

/**
 * The demo request schedule: `[method, path, body]`.
 *
 * Chosen so a panel opened on the resulting container shows something worth
 * looking at — every status bucket it colours, two methods, a parameterised
 * route, the async handler, and the handler that throws.
 */
const DEMO_REQUESTS = [
  ["GET", "/api/users", null],
  ["POST", "/api/users", '{"name":"Carol"}'],
  ["GET", "/api/users/2", null],
  ["GET", "/api/users/999", null],
  ["GET", "/static/app.css", null],
  ["GET", "/api/reports/slow", null],
  ["GET", "/api/boom", null],
];

/** Issue one real HTTP request and resolve once the response is complete. */
function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body !== null && body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port: port,
        method: method,
        path: path,
        headers: headers,
        // A fresh socket per request keeps the recorded async contexts
        // one-per-request instead of folding several onto a reused socket.
        agent: false,
      },
      (res) => {
        let received = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
        });
        res.on("end", () =>
          resolve({
            method: method,
            path: path,
            statusCode: res.statusCode,
            bytes: received,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

/** The schedule this run should drive. */
function schedule() {
  const raw = process.env.CT_EXPRESS_REQUESTS;
  if (!raw) return DEMO_REQUESTS;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("CT_EXPRESS_REQUESTS must be a non-empty JSON array");
  }
  return parsed;
}

async function main() {
  const app = buildApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const requests = schedule();
  const concurrent = process.env.CT_EXPRESS_CONCURRENT === "1";

  let results;
  if (concurrent) {
    // Every request in flight at once: their handlers interleave across the
    // event loop, which is what makes `concurrent_with_siblings` true and
    // `contiguous_on_one_thread` false for the overlapping ones.
    results = await Promise.all(
      requests.map(([method, path, body]) => request(port, method, path, body)),
    );
  } else {
    // Strictly one at a time: nothing else is scheduled between a request's
    // span opening and settling, so a handler that never awaits stays
    // contiguous on one thread.
    results = [];
    for (const [method, path, body] of requests) {
      results.push(await request(port, method, path, body));
    }
  }

  for (const result of results) {
    console.log(
      `${result.method} ${result.path} -> ${result.statusCode} (${result.bytes} bytes)`,
    );
  }

  await new Promise((resolve) => server.close(resolve));
}

main().then(
  () => {
    // Let the process exit naturally so the recorder's `exit` hook writes the
    // container.  Nothing keeps the loop alive once the server is closed.
  },
  (err) => {
    console.error(`demo driver failed: ${err && err.stack}`);
    process.exitCode = 1;
  },
);

module.exports = { DEMO_REQUESTS, request };
