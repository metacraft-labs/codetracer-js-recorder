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

    // The platform's own state: where the visitor came from, the browser,
    // the device, the network, the engine's counters, the fonts, a canvas's
    // text metrics and a socket's unsent bytes. Every value goes into a
    // slot, so the final checkpoint compares each.
    state: function () {
      var c = navigator.connection;
      slot("referrer", document.referrer);
      slot("onLine", navigator.onLine);
      slot(
        "connection",
        c ? [c.effectiveType, c.rtt, c.saveData].join(":") : "none",
      );
      slot("ua", navigator.userAgent.length + ":" + navigator.webdriver);
      slot("languages", navigator.languages.join(","));
      slot(
        "hardware",
        navigator.hardwareConcurrency + ":" + navigator.maxTouchPoints,
      );
      slot(
        "screen",
        [
          screen.width,
          screen.height,
          screen.colorDepth,
          screen.orientation.type,
        ].join(":"),
      );
      slot(
        "memory",
        performance.memory ? performance.memory.jsHeapSizeLimit : "none",
      );
      var counts = performance.eventCounts;
      var n = 0;
      counts.forEach(function () {
        n++;
      });
      slot(
        "eventCounts",
        [
          counts.size,
          counts.get("click"),
          counts.has("keydown"),
          Array.from(counts.keys()).length,
          n,
        ].join(":"),
      );
      slot(
        "fonts",
        document.fonts.status + ":" + document.fonts.check("12px serif"),
      );
      var ctx2d = document.createElement("canvas").getContext("2d");
      ctx2d.font = "13px sans-serif";
      slot("measure", ctx2d.measureText("boundary").width);
      var ws = new WebSocket(location.origin.replace("http", "ws") + "/api/ws");
      ws.onopen = function () {
        // Counted as unsent the moment it is queued (WebSocket standard,
        // `send()`: "increase the bufferedAmount"); short enough for the
        // fixture server's frame reader.
        ws.send(new Array(101).join("x"));
        slot("buffered", ws.bufferedAmount);
        ws.close();
        done();
      };
    },

    // A chain of awaits of a platform promise that settles at once
    // (`createImageBitmap` of an `ImageData`), started from a timer nested
    // past five, where HTML clamps a timer to 4 ms: what the chain costs the
    // page, which a recorder must not raise.
    awaits: function () {
      var n = 100;
      function chain(depth) {
        if (depth > 0) {
          setTimeout(function () {
            chain(depth - 1);
          }, 0);
          return;
        }
        var t0 = performance.now();
        var i = 0;
        function step() {
          if (i === n) {
            slot("awaits", n + ":" + (performance.now() - t0));
            done();
            return;
          }
          i++;
          createImageBitmap(new ImageData(1, 1)).then(step);
        }
        step();
      }
      chain(6);
    },

    // Platform promises that settle in tasks of their own with what the
    // visitor's machine says, interleaved with a timer: each continuation
    // writes what it got and reads the clock, so both the outcome and the
    // order are checked.
    promises: function () {
      var order = [];
      function note(what) {
        order.push(what);
        Date.now();
      }
      function failed(what) {
        return function (e) {
          note(
            what + ":rejected:" + e.name + ":" + (e instanceof DOMException),
          );
        };
      }
      navigator.storage.estimate().then(function (e) {
        note("estimate:" + e.quota + ":" + e.usage);
      }, failed("estimate"));
      navigator.storage.persisted().then(function (p) {
        note("persisted:" + p);
      }, failed("persisted"));
      document.fonts.ready.then(function (s) {
        note("ready:" + (s === document.fonts));
      }, failed("ready"));
      document.fonts.load("12px serif").then(function (faces) {
        note("fontsLoad:" + faces.length);
      }, failed("fontsLoad"));
      var face = new FontFace("ct-missing", "local(ct-no-such-font)");
      face.load().then(function (f) {
        note("faceLoad:" + (f === face));
      }, failed("faceLoad"));
      var img = new Image();
      img.src = "resources-dot.svg";
      img.decode().then(function () {
        note("decode:ok");
      }, failed("decode"));
      createImageBitmap(new ImageData(2, 3)).then(function (b) {
        note("bitmap:" + b.width + "x" + b.height);
      }, failed("bitmap"));
      navigator.clipboard.writeText("copied").then(function () {
        note("clipboard:ok");
      }, failed("clipboard"));
      navigator.userAgentData.getHighEntropyValues(["platform"]).then(function (
        v,
      ) {
        note("uaData:" + v.platform + ":" + v.mobile);
      }, failed("uaData"));
      setTimeout(function () {
        note("timer");
      }, 0);
      setTimeout(function () {
        slot("order", order.join(","));
        done();
      }, 1000);
    },

    // The network going and coming back: each event is input, and the
    // `navigator.onLine` its listener reads comes from the log.
    online: function () {
      var seen = [];
      function on(e) {
        seen.push(e.type + ":" + navigator.onLine);
        Date.now();
        if (e.type === "online") {
          slot("online", seen.join(","));
          done();
        }
      }
      window.addEventListener("offline", on);
      window.addEventListener("online", on);
      document.body.setAttribute("data-ready", "1");
    },

    // The viewport changing under the page: the window's `resize`, the
    // visual viewport's, and the `change` of the media query lists whose
    // `matches` flips, with what each listener then reads of the window's
    // geometry and the lists. Two lists of one query are two targets.
    viewport: function () {
      var seen = [];
      var narrow = matchMedia("(max-width: 500px)");
      var narrow2 = matchMedia("(max-width: 500px)");
      var wide = matchMedia("(min-width: 5000px)");
      slot(
        "start",
        [
          innerWidth,
          innerHeight,
          outerWidth,
          devicePixelRatio,
          scrollY,
          narrow.matches,
          wide.matches,
          visualViewport.width,
        ].join(","),
      );
      var finishing = false;
      function finish() {
        if (finishing) return;
        finishing = true;
        setTimeout(function () {
          slot("seen", seen.join(" "));
          done();
        }, 300);
      }
      window.addEventListener("resize", function (e) {
        seen.push(
          "resize:" +
            innerWidth +
            "x" +
            innerHeight +
            ":" +
            narrow.matches +
            ":" +
            (e.target === window),
        );
        finish();
      });
      narrow.addEventListener("change", function (e) {
        seen.push("narrow:" + e.matches + ":" + e.media + ":" + narrow.matches);
      });
      narrow2.onchange = function (e) {
        seen.push("narrow2:" + e.matches + ":" + (e.target === narrow2));
      };
      visualViewport.addEventListener("resize", function () {
        seen.push("vv:" + visualViewport.width + ":" + visualViewport.scale);
      });
      document.body.setAttribute("data-ready", "1");
    },

    // Focus the page's listeners of a media query list's `change` and of the
    // visual viewport's `resize` move: no node, so the window's listeners
    // never see those events, and the `focus` each `focus()` dispatches
    // inside the page's listener is the page's own (not input), which must
    // reach its listeners on replay as on record.
    "viewport-focus": function () {
      var seen = [];
      var narrow = matchMedia("(max-width: 500px)");
      var a = document.createElement("input");
      a.id = "byList";
      var b = document.createElement("input");
      b.id = "byViewport";
      document.body.appendChild(a);
      document.body.appendChild(b);
      function onFocus(e) {
        seen.push(
          "focus:" + e.target.id + ":" + e.isTrusted + ":" + (Date.now() > 0),
        );
      }
      a.addEventListener("focus", onFocus);
      b.addEventListener("focus", onFocus);
      narrow.addEventListener("change", function () {
        seen.push("change");
        a.focus();
      });
      visualViewport.addEventListener("resize", function () {
        seen.push("vv");
        b.focus();
      });
      window.addEventListener("resize", function () {
        setTimeout(function () {
          slot("seen", seen.join(" "));
          done();
        }, 300);
      });
      document.body.setAttribute("data-ready", "1");
    },

    // Notifications the page shows. Headless Chromium refuses them (its
    // `Notification.permission` is "denied" even when the context grants
    // it), so each gets a real `error`; the visitor's system showing,
    // closing and the visitor clicking one (`show`, `close`, `click`) are
    // never dispatched there, and the test writes them into the log. Each
    // listener of the first reads one value of its own, so each event must
    // be dispatched at that notification for its read to happen; the second
    // listens for `error` only. `timestamp` defaults to the visitor's clock.
    notification: function () {
      slot(
        "state",
        [Notification.permission, Notification.maxActions].join(","),
      );
      var first = new Notification("first", { body: "b" });
      var second = new Notification("second", { timestamp: 7 });
      slot("ts", first.timestamp + "," + second.timestamp);
      first.onshow = function () {
        Notification.permission;
      };
      first.addEventListener("close", function () {
        Notification.maxActions;
      });
      first.onclick = function () {
        first.timestamp;
      };
      var errors = [];
      function failed(which) {
        return function (e) {
          errors.push(
            which + ":" + (e.target === (which === "first" ? first : second)),
          );
          if (errors.length === 2) {
            slot(
              "errors",
              errors.sort().join(" ") + ":" + Notification.permission,
            );
            done();
          }
        };
      }
      first.onerror = failed("first");
      second.addEventListener("error", failed("second"));
    },

    // A label the user clicks: the browser forwards the click to its
    // checkbox (HTML, the label element's activation behavior), which the
    // page's listener counts.
    "label-click": function () {
      var label = document.createElement("label");
      label.id = "lab";
      label.textContent = "toggle";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.id = "labbox";
      label.appendChild(box);
      document.body.appendChild(label);
      var clicks = 0;
      box.addEventListener("click", function () {
        clicks++;
        Date.now();
        slot("box", clicks + ":" + box.checked);
      });
      box.addEventListener("change", function () {
        setTimeout(function () {
          slot("clicks", clicks);
          done();
        }, 100);
      });
      document.body.setAttribute("data-ready", "1");
    },

    // A page that replaces the global `Error` with a function that makes
    // the platform's errors (as error-tracking and zone libraries have
    // done): the stack the shim reads to tell the browser's events from the
    // page's must still be the platform's. The user's click is input, and
    // the focus the page's listener moves is not.
    "error-replaced": function () {
      var NativeError = Error;
      window.Error = function Error(message) {
        return new NativeError(message);
      };
      window.Error.prototype = NativeError.prototype;
      var button = document.createElement("button");
      button.id = "err";
      button.textContent = "go";
      var input = document.createElement("input");
      input.id = "errfield";
      document.body.appendChild(button);
      document.body.appendChild(input);
      input.addEventListener("focus", function () {
        Date.now();
      });
      button.addEventListener("click", function () {
        input.focus();
        slot("clicked", Date.now() > 0);
        done();
      });
      document.body.setAttribute("data-ready", "1");
    },

    // Focus the page's own code moves: `focus()` dispatches `focus` and
    // `focusin` (trusted) inside the call, in the page's task.
    "script-focus": function () {
      var seen = [];
      var input = document.createElement("input");
      input.id = "moved";
      document.body.appendChild(input);
      input.addEventListener("focus", function (e) {
        seen.push("focus:" + e.isTrusted + ":" + (Date.now() > 0));
      });
      setTimeout(function () {
        seen.push("before");
        input.focus();
        seen.push("after:" + (document.activeElement === input));
        slot("seen", seen.join(" "));
        done();
      }, 10);
    },

    // Focus the page's listener of the user's click moves, and a checkbox
    // the page clicks itself: each event is dispatched inside the page's
    // own call, in the click's task.
    "click-focus": function () {
      var seen = [];
      var button = document.createElement("button");
      button.id = "go";
      button.textContent = "go";
      var input = document.createElement("input");
      input.id = "field";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.id = "box2";
      document.body.appendChild(button);
      document.body.appendChild(input);
      document.body.appendChild(box);
      input.addEventListener("focus", function (e) {
        seen.push("focus:" + e.isTrusted + ":" + (Date.now() > 0));
      });
      box.addEventListener("change", function (e) {
        seen.push("change:" + e.isTrusted + ":" + box.checked);
      });
      button.addEventListener("click", function () {
        seen.push("click");
        input.focus();
        box.click();
        seen.push("after:" + (document.activeElement === input));
        slot("seen", seen.join(" "));
        done();
      });
      document.body.setAttribute("data-ready", "1");
    },

    // A field the user focuses, whose listener reads the clock: on replay
    // the focus effect is applied, then the recorded `focus` injected, and
    // the listener runs once, for the latter.
    "user-focus": function () {
      var input = document.createElement("input");
      input.id = "typed";
      document.body.appendChild(input);
      var seen = 0;
      input.addEventListener("focus", function () {
        seen++;
        Date.now();
        slot("focused", seen);
        done();
      });
      document.body.setAttribute("data-ready", "1");
    },

    // A media element's own `resize` (its video's size became known), which
    // is a resource event of the document, never the window's input. The
    // video plays a canvas's stream (refused on record: `captureStream`
    // carries the canvas's pixels; this case is checked on record only).
    "media-resize": function () {
      var c = document.createElement("canvas");
      c.width = 8;
      c.height = 6;
      c.getContext("2d").fillRect(0, 0, 8, 6);
      var v = document.createElement("video");
      v.id = "vid";
      v.muted = true;
      document.body.appendChild(v);
      v.addEventListener("resize", function () {
        slot("resize", v.videoWidth + "x" + v.videoHeight);
        done();
      });
      v.srcObject = c.captureStream(10);
      v.play().catch(function () {});
    },

    // The window losing and regaining the focus (to a frame of its own and
    // back), and whether the document has it then.
    focus: function () {
      var seen = [];
      window.addEventListener("blur", function () {
        seen.push("blur:" + document.hasFocus());
      });
      window.addEventListener("focus", function () {
        seen.push("focus:" + document.hasFocus());
        slot("seen", seen.join(" "));
        done();
      });
      // At a fixed place, so the test clicks into it with the mouse alone
      // (a locator's click would run the driver's own code in the page).
      var f = document.createElement("iframe");
      f.id = "frame";
      f.style.cssText =
        "position: fixed; left: 0; top: 300px; width: 200px; height: 100px";
      f.srcdoc = "<input id=inner>";
      f.onload = function () {
        document.body.setAttribute("data-ready", "1");
      };
      document.body.appendChild(f);
      slot("start", document.hasFocus());
    },

    // The page's lifecycle: `pageshow` (in the document's load, as on
    // record), and the events headless Chromium never dispatches, which
    // the tests write into the log (`visibilitychange`, `freeze`, `resume`
    // at the document, `languagechange` at the window). Their listeners
    // only read the state those events report, so what they read is
    // compared read by read; `pageshow`'s writes what it got.
    lifecycle: function () {
      window.addEventListener("pageshow", function (e) {
        slot("pageshow", e.persisted + ":" + e.isTrusted);
        slot(
          "state",
          [
            document.visibilityState,
            document.hidden,
            document.wasDiscarded,
          ].join(","),
        );
        done();
      });
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") document.hidden;
      });
      document.onfreeze = function () {
        document.visibilityState;
      };
      document.addEventListener("resume", function () {
        document.wasDiscarded;
      });
      window.onlanguagechange = function () {
        navigator.language;
      };
    },

    // The user leaving: the page asks to stay (the test dismisses the
    // dialog, so the page and its session go on).
    beforeunload: function () {
      window.addEventListener("beforeunload", function (e) {
        e.preventDefault();
        e.returnValue = "";
        slot(
          "beforeunload",
          [e.cancelable, e instanceof BeforeUnloadEvent, Date.now() > 0].join(
            ":",
          ),
        );
        done();
      });
      document.body.setAttribute("data-ready", "1");
    },

    // The permission- and device-dependent state a page reads, and the
    // platform promises that report on it.
    device: function () {
      var order = [];
      function note(what) {
        order.push(what);
      }
      function failed(what) {
        return function (e) {
          note(what + ":rejected:" + e.name);
        };
      }
      slot(
        "state",
        [
          Notification.permission,
          document.hasFocus(),
          document.visibilityState,
          document.hidden,
          document.wasDiscarded,
          navigator.userActivation.isActive,
          navigator.userActivation.hasBeenActive,
          visualViewport.scale,
          visualViewport.offsetTop,
        ].join(","),
      );
      var pending = [
        document.hasStorageAccess().then(function (v) {
          note("hasStorageAccess:" + v);
        }, failed("hasStorageAccess")),
        document.requestStorageAccess().then(function (v) {
          note("requestStorageAccess:" + v);
        }, failed("requestStorageAccess")),
        navigator.mediaDevices.enumerateDevices().then(function (list) {
          var seen = list
            .map(function (d) {
              var caps =
                typeof d.getCapabilities === "function"
                  ? d.getCapabilities()
                  : undefined;
              return [
                d.kind,
                d.label,
                d.deviceId,
                d.groupId,
                d instanceof MediaDeviceInfo,
                d instanceof InputDeviceInfo,
                d.toJSON().label,
                caps === undefined ? "-" : caps.width && caps.width.max,
              ].join("/");
            })
            .join(";");
          note("devices:" + seen);
          // What the page saw, also as a read the replay checks: a replay
          // that hands it other devices diverges here, naming them.
          localStorage.getItem("devices:" + seen);
        }, failed("devices")),
        Notification.requestPermission(function (p) {
          note("callback:" + p);
        }).then(function (p) {
          note("permission:" + p);
        }, failed("permission")),
      ];
      Promise.all(pending).then(function () {
        slot("order", order.join(","));
        done();
      });
    },

    // The promises that are attributes keep their identity across reads,
    // as the platform's do, and change when the platform's changes.
    "fonts-identity": function () {
      var a = document.fonts.ready;
      var b = document.fonts.ready;
      var face = new FontFace("ct-identity", "local(ct-no-such-font)");
      var c = face.loaded;
      var d = face.loaded;
      slot("same", [a === b, c === d, a === c].join(","));
      var left = 2;
      function settled() {
        if (--left === 0) done();
      }
      a.then(function (s) {
        slot("ready", s === document.fonts);
        settled();
      });
      c.then(
        function () {
          slot("loaded", "resolved");
          settled();
        },
        function (e) {
          slot("loaded", e.name + ":" + (face.loaded === c));
          slot("after", document.fonts.ready === a);
          settled();
        },
      );
      face.load().catch(function () {});
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
        // A canvas read back: its pixels are the visitor's GPU's and fonts'.
        canvas: function () {
          var c = document.createElement("canvas").getContext("2d");
          c.fillText("x", 1, 10);
          slot("canvas", c.getImageData(0, 0, 4, 4).data.length);
          done();
        },
        // The clipboard's contents: the user's data.
        clipboard: function () {
          navigator.clipboard.readText().then(
            function (t) {
              slot("clipboard", t.length);
              done();
            },
            function (e) {
              slot("clipboard", e.name);
              done();
            },
          );
        },
        // The Cache API: storage with contents of its own.
        caches: function () {
          caches.open("c").then(
            function () {
              slot("caches", "open");
              done();
            },
            function (e) {
              slot("caches", e.name);
              done();
            },
          );
        },
        // A permission's live status.
        permissions: function () {
          navigator.permissions
            .query({ name: "geolocation" })
            .then(function (s) {
              slot("permissions", s.state);
              done();
            });
        },
        // A live battery status, whose events the browser dispatches.
        battery: function () {
          navigator.getBattery().then(
            function (b) {
              slot("battery", typeof b.level);
              done();
            },
            function (e) {
              slot("battery", e.name);
              done();
            },
          );
        },
        // The visitor's position: personal data.
        geolocation: function () {
          navigator.geolocation.getCurrentPosition(
            function () {
              slot("geolocation", "position");
              done();
            },
            function (e) {
              slot("geolocation", e.code);
              done();
            },
            { timeout: 200 },
          );
        },
        // A camera's stream: media the log cannot carry.
        "user-media": function () {
          navigator.mediaDevices.getUserMedia({ video: true }).then(
            function () {
              slot("media", "stream");
              done();
            },
            function (e) {
              slot("media", e.name);
              done();
            },
          );
        },
        // An event the platform dispatches at the document's font set, which
        // the page listens for.
        "fonts-event": function () {
          document.fonts.addEventListener("loadingerror", function () {
            slot("fonts", "loadingerror");
            done();
          });
          document.fonts.onloadingdone = function () {
            slot("fonts", "loadingdone");
            done();
          };
          var face = new FontFace("ct-missing", "local(ct-no-such-font)");
          document.fonts.add(face);
          face.load().catch(function () {});
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

    // Window handlers set by markup on <body> (values-markup.html): a
    // message the page posts to itself, a history traversal's popstate, a
    // fragment navigation's hashchange. Each sees its event as trusted, as
    // on record.
    markup: function () {
      window.postMessage("m", "*");
      setTimeout(function () {
        slot("markup", window.__markupSaw);
        done();
      }, 200);
    },
    "markup-popstate": function () {
      history.pushState({ n: 1 }, "", "?case=markup-popstate&step=2");
      history.back();
      setTimeout(function () {
        slot("popstate", window.__popSaw);
        done();
      }, 200);
    },
    "markup-hashchange": function () {
      location.hash = "moved";
      setTimeout(function () {
        slot("hashchange", window.__hashSaw);
        done();
      }, 200);
    },
  };

  // Each case starts once the document has loaded, so what it reads is in
  // tasks of the page's own; with `at=loading`, while the script runs, in
  // the document's loading (the parser waits for this script at the end of
  // the body), so its records interleave with the document's own tasks.
  if (params.get("at") === "loading") {
    cases[params.get("case")]();
  } else {
    window.addEventListener("load", function () {
      cases[params.get("case")]();
    });
  }
})();
