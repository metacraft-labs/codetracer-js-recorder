// The fixture page of tests/boundary/replay-values.test.ts: values a page
// reads that the boundary log must hold for a replay to give the page the
// same ones. `?case=<name>` picks one scenario; each writes what it read
// into `<li id="r-<slot>">` slots (so the final checkpoint compares them)
// and sets `<body data-done="1">` when it is finished.
(function () {
  var params = new URLSearchParams(location.search);
  var out = document.getElementById("out");
  function slot(name, value) {
    var li = document.getElementById("r-" + name);
    if (li === null) {
      li = document.createElement("li");
      li.id = "r-" + name;
      out.appendChild(li);
    }
    li.textContent = name + "=" + value;
  }
  function done() {
    document.body.setAttribute("data-done", "1");
  }
  function path(url) {
    return String(url).replace(location.origin, "");
  }

  var cases = {
    // A redirected fetch: its final URL, `redirected`, `statusText`, `type`,
    // and whether its headers can be changed.
    "fetch-meta": function () {
      fetch("/api/redirect")
        .then(function (r) {
          slot("url", path(r.url));
          slot("redirected", r.redirected);
          slot("statusText", JSON.stringify(r.statusText));
          slot("type", r.type);
          try {
            r.headers.set("x-page", "1");
            slot("headers", "mutable");
          } catch (e) {
            slot("headers", e.name);
          }
          return r.json();
        })
        .then(function (j) {
          slot("value", j.value);
          done();
        });
    },

    // A redirected XMLHttpRequest: `responseURL`, `statusText`, and whether
    // its events are trusted.
    "xhr-meta": function () {
      var x = new XMLHttpRequest();
      var trusted = [];
      x.open("GET", "/api/redirect");
      x.onreadystatechange = function (e) {
        trusted.push("rsc" + x.readyState + ":" + e.isTrusted);
      };
      x.addEventListener("load", function (e) {
        trusted.push("load:" + e.isTrusted);
        slot("responseURL", path(x.responseURL));
        slot("statusText", JSON.stringify(x.statusText));
        slot("status", x.status);
      });
      x.onloadend = function () {
        slot("trusted", trusted.join(","));
        done();
      };
      x.send();
    },

    // A WebSocket: the subprotocol the server chose, a text and a binary
    // message (the binary one's bytes are valid UTF-8).
    "ws-frames": function () {
      var ws = new WebSocket(
        location.origin.replace("http", "ws") + "/api/ws",
        ["chat", "other"],
      );
      ws.binaryType = "arraybuffer";
      var got = [];
      ws.onopen = function (e) {
        slot("protocol", ws.protocol + ":" + e.isTrusted);
        slot("extensions", JSON.stringify(ws.extensions));
      };
      ws.onmessage = function (e) {
        got.push(
          typeof e.data === "string"
            ? "text:" + e.data
            : "binary:" + new Uint8Array(e.data).join("."),
        );
        got.push(e.isTrusted);
        if (got.length === 4) {
          slot("messages", got.join(","));
          ws.close();
        }
      };
      ws.onclose = function (e) {
        slot("close", e.code + ":" + e.isTrusted);
        done();
      };
    },

    // An event stream whose events are named and carry ids.
    "sse-named": function () {
      var es = new EventSource("/api/sse?n=3&interval=30&event=tick&id=1");
      var n = 0;
      es.addEventListener("tick", function (e) {
        slot("ev" + n, [e.type, e.data, e.lastEventId, e.isTrusted].join(":"));
        n++;
        if (n === 3) {
          es.close();
          done();
        }
      });
    },

    // An idle callback's deadline.
    idle: function () {
      requestIdleCallback(
        function (d) {
          slot("remaining", d.timeRemaining());
          slot("didTimeout", d.didTimeout);
          slot("isDeadline", d instanceof IdleDeadline);
          done();
        },
        { timeout: 2000 },
      );
    },

    // Observer entries: an IntersectionObserver's, a ResizeObserver's and a
    // MutationObserver's records.
    observers: function () {
      var box = document.getElementById("box");
      var seen = 0;
      function one() {
        if (++seen === 3) done();
      }
      var io = new IntersectionObserver(function (entries) {
        var e = entries[0];
        slot(
          "io",
          [
            e instanceof IntersectionObserverEntry,
            e.target.id,
            e.isIntersecting,
            e.intersectionRatio,
            e.boundingClientRect.width,
            e.time > 0,
          ].join(":"),
        );
        io.disconnect();
        one();
      });
      io.observe(box);
      var ro = new ResizeObserver(function (entries) {
        var e = entries[0];
        slot(
          "ro",
          [
            e.target.id,
            e.contentRect.width,
            e.borderBoxSize[0].inlineSize,
            e.contentBoxSize[0].blockSize,
          ].join(":"),
        );
        ro.disconnect();
        one();
      });
      ro.observe(box);
      var list = document.getElementById("list");
      var mo = new MutationObserver(function (records) {
        slot(
          "mo",
          records
            .map(function (r) {
              return r.type + ":" + r.addedNodes.length;
            })
            .join(","),
        );
        mo.disconnect();
        one();
      });
      mo.observe(list, { childList: true });
      var li = document.createElement("li");
      li.textContent = "added";
      list.appendChild(li);
    },

    // The files a user chose: what the page can read without their contents,
    // and, with `read=1`, their contents.
    files: function () {
      var input = document.getElementById("file");
      input.addEventListener("change", function () {
        var files = Array.prototype.slice.call(input.files);
        slot(
          "files",
          files
            .map(function (f) {
              return [f.name, f.size, f.type, f.lastModified].join(":");
            })
            .join("|"),
        );
        slot("value", input.value);
        if (params.get("read") === "1") {
          files[0].text().then(function (t) {
            slot("content", t);
            done();
          });
        } else if (params.get("read") === "url") {
          // An object URL lets the page read the contents through a fetch
          // or an element, out of the shim's sight.
          slot("objectURL", URL.createObjectURL(files[0]).slice(0, 5));
          done();
        } else {
          done();
        }
      });
      document.body.setAttribute("data-ready", "1");
    },

    // The page's own URL: its query and fragment.
    url: function () {
      slot("search", location.search);
      slot("hash", location.hash);
      slot("x", new URLSearchParams(location.search).get("x"));
      done();
    },

    // Promises the platform settles in tasks of their own, interleaved
    // with a timer: each continuation reads the clock, so the order they ran
    // in is checked.
    platform: function () {
      var order = [];
      function note(what) {
        order.push(what);
        Date.now();
      }
      new Blob(["abc"]).text().then(function (t) {
        note("blob:" + t);
      });
      new Request("/api/echo", { method: "POST", body: "req" })
        .text()
        .then(function (t) {
          note("request:" + t);
        });
      new Response("resp").arrayBuffer().then(function (b) {
        note("response:" + b.byteLength);
      });
      crypto.subtle
        .digest("SHA-256", new TextEncoder().encode("d"))
        .then(function (b) {
          note("digest:" + new Uint8Array(b)[0]);
        });
      setTimeout(function () {
        note("timer");
      }, 0);
      setTimeout(function () {
        slot("order", order.join(","));
        done();
      }, 300);
    },

    // The performance timeline: resource and navigation entries, a mark and
    // a measure, the time origin, the legacy timing object, and a
    // PerformanceObserver.
    perf: function () {
      performance.mark("a");
      var m = performance.measure("m", "a");
      slot("measure", m.name + ":" + m.entryType + ":" + (m.duration >= 0));
      slot("origin", performance.timeOrigin);
      var res = performance.getEntriesByType("resource");
      slot(
        "resources",
        res.length +
          ":" +
          res
            .map(function (e) {
              return path(e.name) + "@" + e.startTime;
            })
            .join("|"),
      );
      var nav = performance.getEntriesByType("navigation")[0];
      slot(
        "navigation",
        [
          nav.type,
          nav instanceof PerformanceNavigationTiming,
          nav.domInteractive,
        ].join(":"),
      );
      slot("timing", performance.timing.navigationStart);
      new PerformanceObserver(function (list) {
        var b = list.getEntriesByName("b")[0];
        slot(
          "observed",
          list.getEntries().length + ":" + b.entryType + ":" + b.startTime,
        );
        done();
      }).observe({ type: "mark" });
      performance.mark("b");
    },

    // Messages the page posts to itself, through the window and a
    // MessageChannel, interleaved with a timer.
    messages: function () {
      var order = [];
      function note(what) {
        order.push(what);
        Date.now();
      }
      window.addEventListener("message", function (e) {
        note(
          "window:" + e.data + ":" + e.isTrusted + ":" + (e.source === window),
        );
      });
      var ch = new MessageChannel();
      ch.port2.onmessage = function (e) {
        note("port:" + e.data + ":" + e.isTrusted);
      };
      window.postMessage("w1", "*");
      ch.port1.postMessage("p1");
      setTimeout(function () {
        note("timer");
      }, 0);
      window.postMessage("w2", "/");
      ch.port1.postMessage("p2");
      setTimeout(function () {
        slot("order", order.join(","));
        done();
      }, 300);
    },

    // What the shim cannot order exactly, and refuses: `?use=` picks one
    // seam (one Refusal is written per feature, so each needs its own
    // recording). The page keeps working: each writes what it got.
    refused: function () {
      var uses = {
        // A Blob read as a stream: its chunks settle in tasks of their own.
        stream: function () {
          new Blob(["ab"])
            .stream()
            .getReader()
            .read()
            .then(function (r) {
              slot("stream", r.value.length);
              done();
            });
        },
        // A FileReader: its events are tasks with platform-chosen values.
        reader: function () {
          var fr = new FileReader();
          fr.onload = function () {
            slot("reader", fr.result);
            done();
          };
          fr.readAsText(new Blob(["ab"]));
        },
        // A crypto.subtle method other than digest.
        subtle: function () {
          crypto.subtle
            .generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"])
            .then(function (k) {
              slot("subtle", k.type);
              done();
            });
        },
        // A port moved through window.postMessage: the shim sees no
        // transfer list, so it cannot follow the port's messages.
        port: function () {
          var ch = new MessageChannel();
          window.addEventListener("message", function (e) {
            e.ports[0].onmessage = function (m) {
              slot("port", m.data);
              done();
            };
          });
          window.postMessage("take", "*", [ch.port2]);
          ch.port1.postMessage("hi");
        },
      };
      uses[params.get("use")]();
    },

    // A message from another document (a frame of the page).
    "message-foreign": function () {
      window.addEventListener("message", function (e) {
        slot("got", e.data);
        done();
      });
      var f = document.createElement("iframe");
      f.srcdoc = "<script>parent.postMessage('from the frame', '*')<\/script>";
      document.body.appendChild(f);
    },

    // A storage event, caused by another page of the same origin.
    "storage-event": function () {
      window.addEventListener("storage", function (e) {
        slot(
          "event",
          [
            e.key,
            e.oldValue,
            e.newValue,
            path(e.url),
            e.storageArea === localStorage,
            e.isTrusted,
          ].join(":"),
        );
        Date.now();
        done();
      });
      document.body.setAttribute("data-ready", "1");
    },

    // A window handler set by script through <body> (HTML's
    // WindowEventHandlers: `body.onmessage` is the window's handler), which
    // is not markup and sees the replayed message as trusted, as on record.
    "body-handler": function () {
      document.body.onmessage = function (e) {
        slot(
          "body",
          [
            e.data,
            e.isTrusted,
            window.onmessage === document.body.onmessage,
          ].join(":"),
        );
        done();
      };
      window.postMessage("b", "*");
    },

    // A window handler set by markup (values-markup.html) and a message the
    // page posts to itself.
    markup: function () {
      window.postMessage("m", "*");
      setTimeout(function () {
        slot("markup", window.__markupSaw);
        done();
      }, 200);
    },
  };

  // Each case starts once the document has loaded, so what it reads is in
  // tasks of the page's own rather than in the document's loading.
  window.addEventListener("load", function () {
    cases[params.get("case")]();
  });
})();
