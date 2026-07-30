# Web-request spans (RS-M9)

The recorder writes one **span** per HTTP request straight into the `.ct`
container it is already producing. There is no `codetracer_spans.jsonl` sidecar,
no second file to find or tail, and no second decoder: the records go out
through the trace format's own span-stream writer and come back through the
canonical Nim span reader.

Specs: [`CTFS-Request-Span-Streams.md`][fmt] for the wire record,
[`Trace-Spans.md`][spans] §2.3–2.4 for the model and the structural bits, and
[`Request-Panel-Live-Sessions.milestones.org`][ms] §RS-M9 for this milestone.

[fmt]: ../../codetracer-specs/Trace-Files/CTFS-Request-Span-Streams.md
[spans]: ../../codetracer-specs/Planned-Features/Trace-Spans.md
[ms]: ../../codetracer-specs/Planned-Features/Request-Panel-Live-Sessions.milestones.org

## Using it

```js
const express = require("express");
const {
  codetracerExpress,
  codetracerExpressErrors,
} = require("@codetracer/express");

const app = express();
app.use(codetracerExpress());       // FIRST — the span covers routing too
app.use(express.json());
// … your routes …
app.use(codetracerExpressErrors()); // AFTER the routes
```

Then record the app as usual:

```sh
codetracer-js-recorder record ./my-app -o ./ct-traces
codetracer-js-recorder read-spans ./ct-traces/trace-1
```

The middleware has no dependencies and does nothing when the process is not
being recorded, so it can stay installed in production. It talks to
`globalThis.__ct.webRequestStart` / `webRequestStop`, the surface the recorder's
runner installs; the canonical definition of that contract, including the
metadata keys the Request Panel reads, is
[`packages/runtime/src/spans.ts`](../packages/runtime/src/spans.ts).

A runnable demo lives in [`test-programs/web/express/`](../test-programs/web/express);
`just demo-request-panel-js` records it and prints the spans, and
`just record-request-panel-fixture <dir>` regenerates codetracer's checked-in
ViewModel fixture from the same session.

## How a span learns its step range

This recorder does not drive the trace writer live. `appendEvents` accumulates
events in memory and `flushAndStop` replays the whole buffer into a freshly
created writer. A span therefore cannot ask "what step am I at?" when the
request starts — the writer does not exist yet.

What `spanOpen` records instead is a **mark**: the length of the buffered event
vector at that instant. During the replay the marks are translated into real
step ids by reading the writer's `next_step_index()` as the replay reaches each
marked position.

That is deliberate, and it is the one thing in this file that must not be
"simplified". `next_step_index()` is the writer's own exec-event counter — the
counter readers walk, and the counter a span's `start_step` / `end_step` and the
Request Panel's `startGeid` are expressed in. It advances for **every**
exec-stream event: absolute steps, `DeltaColumn` column moves, call and return
records, special events, and thread start / exit / switch. A recorder counting
its own `register_step` calls would drift from it immediately, and every row's
double-click would seek to the wrong place.

`express_span_step_ranges_track_the_writers_counter` in
`tests/web/express-spans.test.ts` is the regression guard: it records one
schedule with and without column-aware encoding and requires every span's range
to move, which a self-maintained counter could not do.

Both `webRequestStart` and `webRequestStop` check the async context and flush
the event buffer before taking their mark, so the exec stream records which
context the boundary happened on and the mark really is "the end of everything
recorded so far".

## The structural bits, for Node

[`Trace-Spans.md`][spans] §2.4 is explicit that `contiguous_on_one_thread` is a
property of the recorder's stream layout rather than of the language, and that a
recorder must **compute** it. For this recorder:

| Bit | Value | Why |
| --- | --- | --- |
| `shares_timeline` | always true | One Node process, one exec stream; every span is a slice of one ordering. |
| `contiguous_on_one_thread` | **computed, and genuinely variable** | The runtime maps each Node async context (`async_hooks.executionAsyncId()`) onto a container thread. A handler that runs to completion without yielding is an uninterrupted run; one that `await`s has its own continuation land on a different thread inside its range, as does a request whose neighbour takes the event loop while it is open. |
| `concurrent_with_siblings` | computed | True when the span's resolved `[start_step, end_step]` overlaps another span's. |

The variability is the interesting part and is not incidental: in a **sequential**
schedule a plain `GET` handler is contiguous while an `async` handler and a
`POST` (whose body parser awaits the request body) are not, and in a
**concurrent** schedule the overlapping handlers are neither contiguous nor
alone. `express_span_contiguity_reflects_the_event_loop` requires both values to
appear and requires overlap to appear only when the requests are actually in
flight together, so neither bit can pass as a constant.

`process_ord` is always 0: one recording is one Node process.

## Where a row's double-click lands

Into the handler's source. The instrumenter instruments the application but not
`node_modules`, so a request's step range is made of real per-line steps of the
app's own files, and codetracer's `vm_js_request_panel_rows` walks each range
and requires it to cover that request's own handler lines.

One caveat: `start_step` is the first *exec-stream event* of the interval, and
for a request whose handler resumes on a new async context before running any
instrumented code (a `POST` behind `express.json()`) that first event is a
`ThreadStart`, which carries no source position of its own. The range still
covers the handler; only that one boundary step resolves to the reader's
fallback.

## Why the span settles in `res.end`

The middleware patches `res.end` per request rather than settling on the
response's `finish` event. `res.end` is called synchronously by the handler, so
a handler that never awaited opens and settles its span in one async context and
is genuinely contiguous. `finish` always fires in a fresh async context after
the socket flushes; settling there would put a thread switch inside every span
and make `contiguous_on_one_thread` constantly false — which is to say useless.

`finish` and `close` are still wired as a fallback for a request that never
reaches `res.end` (an aborted connection). Settling is idempotent, so whichever
fires first wins.

## Recording an app with dependencies

`record` writes the instrumented copy of a program to a temporary directory and
runs it from there, so Node's `node_modules` walk starts in the temp dir and
finds nothing. The command now links the project's nearest real `node_modules`
into that directory, which is what makes `require("express")` resolve at all in
a recorded app. Nothing is copied and the link is removed before the temp
directory is deleted.
