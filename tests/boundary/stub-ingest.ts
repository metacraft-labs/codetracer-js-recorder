/**
 * A local stub of the boundary ingest (CodeTracer's Boundary-Ingest
 * specification §3, §4), for the batched upload transport's tests
 * (`tests/boundary/transport.test.ts`).
 *
 * Why a stub, and why it is the only one: the real ingest is a CodeTracer
 * service built on top of this transport, so it cannot serve these tests
 * yet; until it does, tests that upload use a local stub implementing the
 * envelope of §4, and nothing else is mocked. It is a real HTTP server
 * on a loopback port of its own, so every request crosses origins exactly as
 * an upload from a site to the ingest does (CORS preflight included), and it
 * checks what the ingest checks without decoding frames: the envelope, with
 * the shared batch codec (`parseBatch`, held to the Rust parser by the batch
 * vectors), a constant session and build, `batch_seq` idempotence (the same
 * body again is `202`, other bytes `409`), and no cookie or `Authorization`
 * header. Everything else in these tests (the browser, the site's server,
 * the shim, the assembler) is real.
 */

import * as http from "node:http";

import {
  BatchFormatError,
  type ParsedBatch,
  parseBatch,
} from "../../packages/boundary-format/src/index.js";

/** The site key's path on the stub (Boundary-Ingest §3). */
export const STUB_SITE_PATH = "/api/v1/ingest/js-boundary/ct_site_test";

/** One request the stub received, whatever it was. */
export interface StubRequest {
  method: string;
  path: string;
  /** `performance.now()` of this process when the request ended. */
  at: number;
  status?: number;
}

export interface StubIngest {
  /** The ingest base URL a shim is installed with (`--ingest`). */
  base: string;
  /** Every request, in arrival order: preflights, config, batches. */
  requests: StubRequest[];
  /** Every batch accepted (stored), in arrival order, and its parse. */
  batches: { body: Uint8Array; parsed: ParsedBatch }[];
  /** What `GET <base>/config` answers. */
  config: unknown;
  /** Hold every batch's answer from now on, until {@link release}. */
  stall(): void;
  /** Answer the held batches (and every later one at once). */
  release(): void;
  /** Batch requests being held now. */
  held(): number;
  /**
   * Answer the next new batch (a `batch_seq` not seen before) with
   * `status` and do not store it, as the ingest refuses a batch over its
   * size limit (`413`) or its quota (Boundary-Ingest §6).
   */
  refuseNext(status: number): void;
  close(): Promise<void>;
}

/**
 * Start a stub ingest answering `config` on a free loopback port. With
 * `noStore`, every answer carries `Cache-Control: no-store`, which the
 * ingest's do not: the positive control of the back/forward-cache test.
 */
export async function startStubIngest(
  config: unknown,
  options: { noStore?: boolean } = {},
): Promise<StubIngest> {
  const requests: StubRequest[] = [];
  const batches: { body: Uint8Array; parsed: ParsedBatch }[] = [];
  const bySeq = new Map<number, Uint8Array>();
  let session: { id: string; build: string } | undefined;
  let stalled = false;
  let refuseWith: number | undefined;
  const heldAnswers: (() => void)[] = [];

  const stub: StubIngest = {
    base: "",
    requests,
    batches,
    config,
    stall() {
      stalled = true;
    },
    release() {
      stalled = false;
      for (const answer of heldAnswers.splice(0)) answer();
    },
    held: () => heldAnswers.length,
    refuseNext(status: number) {
      refuseWith = status;
    },
    close: async () => {
      stub.release();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const entry: StubRequest = {
        method: req.method ?? "",
        path,
        at: performance.now(),
      };
      requests.push(entry);
      const origin = req.headers.origin;
      const cors: http.OutgoingHttpHeaders =
        origin === undefined ? {} : { "access-control-allow-origin": origin };
      // No `Cache-Control: no-store`, as the ingest's answers carry none: a
      // page served `no-store` that receives a `no-store` answer to a script
      // request is no longer eligible for the back/forward cache, so the
      // transport would change the page's own navigation behaviour.
      const answer = (status: number, body = "", type?: string) => {
        entry.status = status;
        res.writeHead(status, {
          ...cors,
          ...(type === undefined ? {} : { "content-type": type }),
          ...(options.noStore === true ? { "cache-control": "no-store" } : {}),
        });
        res.end(body);
      };

      if (req.method === "OPTIONS") {
        // Boundary-Ingest §3: the origin echoed, no credentials.
        entry.status = 204;
        res.writeHead(204, {
          ...cors,
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        });
        res.end();
        return;
      }
      // No route accepts a cookie or an Authorization header (§3).
      if (
        req.headers.cookie !== undefined ||
        req.headers.authorization !== undefined
      ) {
        answer(403);
        return;
      }
      if (path === `${STUB_SITE_PATH}/config` && req.method === "GET") {
        answer(200, JSON.stringify(stub.config), "application/json");
        return;
      }
      if (path !== `${STUB_SITE_PATH}/batches` || req.method !== "POST") {
        answer(404);
        return;
      }
      const body = new Uint8Array(Buffer.concat(chunks));
      let parsed: ParsedBatch;
      try {
        parsed = parseBatch(body);
      } catch (e) {
        if (!(e instanceof BatchFormatError)) throw e;
        answer(400);
        return;
      }
      const env = parsed.envelope;
      session ??= { id: env.session_id, build: env.build_hash };
      if (env.session_id !== session.id || env.build_hash !== session.build) {
        answer(400);
        return;
      }
      const earlier = bySeq.get(env.batch_seq);
      if (earlier !== undefined) {
        const same =
          earlier.length === body.length &&
          earlier.every((b, i) => b === body[i]);
        answer(same ? 202 : 409);
        return;
      }
      if (refuseWith !== undefined) {
        const status = refuseWith;
        refuseWith = undefined;
        answer(status);
        return;
      }
      bySeq.set(env.batch_seq, body);
      batches.push({ body, parsed });
      if (stalled) heldAnswers.push(() => answer(202));
      else answer(202);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  stub.base = `http://127.0.0.1:${port}${STUB_SITE_PATH}`;
  return stub;
}
