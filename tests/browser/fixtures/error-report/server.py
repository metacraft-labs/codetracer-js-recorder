"""The backend of tests/browser/error-report.test.ts: a server-rendered page
whose request is traced by the real OpenTelemetry Python SDK.

Each `GET /page` is one SERVER span, started before the page is rendered and
ended after it is written. The page carries the span's W3C `traceparent`,
injected by the SDK's own propagator, in a `<meta name="traceparent">`
element and/or a `Server-Timing: traceparent;desc=...` response header. The
span is exported by the SDK's `ConsoleSpanExporter`, writing one JSON object
per span (the SDK's `ReadableSpan.to_json`) to `--span-file`: the backend's
own span output, which the test reads the trace id from.

`GET /shim-page` serves `--shim-template`, a page the test installed the
boundary shim into with the shipped injector, traced the same way: its
`<meta name="traceparent" content="__CT_TRACEPARENT__">` element gets the
span's `traceparent` (or is removed with `meta=off`), and `timing=on` adds
the `Server-Timing` header. `bad=on` hands the page a malformed
`traceparent` instead (the span's, its trace id zeroed), in both places.

`POST /reports` receives the browser's error reports and appends each, with
the request headers that matter to the test (whether a cookie, an
Authorization header or a referrer came with it), to `--report-file` as one
JSON line. It stands in for an ingest route because none accepts these
reports yet.

The server prints `listening <port>` once it accepts connections, and stops
on SIGTERM.
"""

import argparse
import html
import json
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

MAX_REPORT_BODY = 256 * 1024

# The element of the shim template that carries the trace context.
SHIM_META = '<meta name="traceparent" content="__CT_TRACEPARENT__">'

# The page. `{config}` is the reporter's configuration as a JS object
# literal; the consent callback is chosen by the `consent` query value.
PAGE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
{meta}
<title>error report fixture</title>
<script src="/reporter.js"></script>
<script>
  window.__shown = [];
  var consent = {consent};
  window.__reporter = CtErrorReporter.installErrorReporter({{
    enabled: {enabled},
    endpoint: "/reports",
    scrubQueryKeys: ["order"],
    consent: consent,
  }});
</script>
</head>
<body>
<input id="pw" type="password">
<input id="note" data-ct-public>
<button id="boom">boom</button>
<button id="reject">reject</button>
<script>
  document.getElementById("boom").addEventListener("click", function () {{
    var pw = document.getElementById("pw").value;
    throw new Error(
      "login failed for " + pw + " with Authorization: Bearer " + window.__token
    );
  }});
  document.getElementById("reject").addEventListener("click", function () {{
    Promise.reject(new TypeError("payment declined, card " + window.__card));
  }});
</script>
</body>
</html>
"""

CONSENTS = {
    # The callback records what it was shown, then answers.
    "yes": "function (r) { window.__shown.push(r); return true; }",
    "promise": "function (r) { window.__shown.push(r); return Promise.resolve(true); }",
    "no": "function (r) { window.__shown.push(r); return false; }",
    "none": "undefined",
}


def make_tracer(span_file):
    """A tracer whose spans the SDK's console exporter writes to `span_file`."""
    out = open(span_file, "a", encoding="utf-8", buffering=1)
    provider = TracerProvider(
        resource=Resource.create({"service.name": "error-report-fixture"})
    )
    provider.add_span_processor(
        SimpleSpanProcessor(
            ConsoleSpanExporter(
                out=out,
                formatter=lambda span: span.to_json(indent=None) + "\n",
            )
        )
    )
    return provider.get_tracer("error-report-fixture"), provider


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--span-file", required=True)
    parser.add_argument("--report-file", required=True)
    parser.add_argument("--reporter-js", required=True)
    parser.add_argument("--shim-template")
    args = parser.parse_args()

    tracer, provider = make_tracer(args.span_file)
    propagator = TraceContextTextMapPropagator()
    report_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, status, body=b"", content_type=None, headers=()):
            self.send_response(status)
            if content_type:
                self.send_header("Content-Type", content_type)
            for name, value in headers:
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path == "/reporter.js":
                with open(args.reporter_js, "rb") as f:
                    self.send(200, f.read(), "text/javascript; charset=utf-8")
                return
            if url.path not in ("/page", "/shim-page") or (
                url.path == "/shim-page" and not args.shim_template
            ):
                self.send(404)
                return
            q = {k: v[-1] for k, v in parse_qs(url.query).items()}
            case = q.get("case", "")
            with tracer.start_as_current_span(
                "GET " + url.path,
                kind=trace.SpanKind.SERVER,
                attributes={
                    "http.request.method": "GET",
                    "url.path": url.path,
                    "fixture.case": case,
                },
            ):
                carrier = {}
                propagator.inject(carrier)
                traceparent = carrier["traceparent"]
                if q.get("bad", "off") == "on":
                    # Well-formed but for an all-zero trace id, which W3C
                    # Trace Context makes invalid.
                    version, _trace_id, parent_id, flags = traceparent.split("-")
                    traceparent = "-".join([version, "0" * 32, parent_id, flags])
                headers = [
                    # A session cookie the upload must not carry.
                    ("Set-Cookie", "fixture_session=c00kie-value-SECRET; Path=/"),
                    ("Cache-Control", "no-store"),
                ]
                if q.get("timing", "off") == "on":
                    headers.append(
                        ("Server-Timing", 'traceparent;desc="%s"' % traceparent)
                    )
                if url.path == "/shim-page":
                    with open(args.shim_template, "r", encoding="utf-8") as f:
                        page = f.read()
                    page = page.replace(
                        SHIM_META,
                        SHIM_META.replace(
                            "__CT_TRACEPARENT__",
                            html.escape(traceparent, quote=True),
                        )
                        if q.get("meta", "on") == "on"
                        else "",
                    )
                    self.send(
                        200, page.encode("utf-8"), "text/html; charset=utf-8", headers
                    )
                    return
                meta = (
                    '<meta name="traceparent" content="%s">'
                    % html.escape(traceparent, quote=True)
                    if q.get("meta", "on") == "on"
                    else ""
                )
                page = PAGE.format(
                    meta=meta,
                    consent=CONSENTS[q.get("consent", "yes")],
                    enabled="true" if q.get("capture", "on") == "on" else "false",
                )
                self.send(200, page.encode("utf-8"), "text/html; charset=utf-8", headers)

        def do_POST(self):
            if urlsplit(self.path).path != "/reports":
                self.send(404)
                return
            length = int(self.headers.get("Content-Length") or "0")
            if length < 0 or length > MAX_REPORT_BODY:
                self.send(413)
                return
            body = self.rfile.read(length).decode("utf-8", "replace")
            entry = {
                "content_type": self.headers.get("Content-Type"),
                "cookie": self.headers.get("Cookie"),
                "authorization": self.headers.get("Authorization"),
                "referer": self.headers.get("Referer"),
                "body": body,
            }
            with report_lock, open(args.report_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
            self.send(204)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)

    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    print("listening %d" % server.server_address[1], flush=True)
    try:
        server.serve_forever()
    finally:
        provider.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
