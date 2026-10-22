// The fixture page of the streamed-response tests in
// tests/boundary/record-shim-fidelity.test.ts. `?case=<name>` picks one
// scenario; each writes its results into `<li id="r-<slot>">` slots and sets
// `<body data-done="1">` when it is finished.
//
// After each piece of a stream reaches it, the page reads `Date.now()`: a
// boundary read made in the continuation of that piece, so the log shows
// whether the piece's record precedes what the page did with it.
(function () {
  var params = new URLSearchParams(location.search);
  window.__errors = { error: 0, rejection: 0 };
  window.addEventListener("error", function () {
    window.__errors.error++;
  });
  window.addEventListener("unhandledrejection", function () {
    window.__errors.rejection++;
  });

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
  var decoder = new TextDecoder();

  var cases = {
    // A body that never ends: the page reads three pieces as they arrive,
    // then cancels its reader.
    "fetch-forever": function () {
      fetch("/api/stream?n=forever&interval=100").then(function (r) {
        slot("status", r.status);
        var reader = r.body.getReader();
        var got = [];
        function next() {
          return reader.read().then(function (res) {
            if (res.done) {
              slot("ended", "yes");
              done();
              return;
            }
            got.push(decoder.decode(res.value));
            window.__readAt = Date.now();
            slot("chunks", got.join("|"));
            if (got.length === 3) {
              slot("ended", "no");
              return reader.cancel().then(done);
            }
            return next();
          });
        }
        return next();
      });
    },

    // A finite body that arrives in three pieces, read whole with text().
    "fetch-text": function () {
      fetch("/api/stream?n=3&interval=50")
        .then(function (r) {
          return r.text();
        })
        .then(function (t) {
          window.__readAt = Date.now();
          slot("text", JSON.stringify(t));
          done();
        });
    },

    // A body that has fully arrived before the page reads it, in a later
    // task, so its bytes are already there when the page asks for them.
    "fetch-buffered": function () {
      fetch("/api/data").then(function (r) {
        setTimeout(function () {
          r.json().then(function (j) {
            slot("json", j.value);
            done();
          });
        }, 300);
      });
    },

    // What a page can observe of a fetched Response object, which the
    // shim's streamed delivery must leave as the platform makes it.
    "fetch-shape": function () {
      var shape = [];
      fetch("/api/redirect")
        .then(function (r) {
          shape.push(
            r.url.replace(location.origin, ""),
            r.type,
            r.redirected,
            r.status,
            JSON.stringify(r.statusText),
            r.ok,
            r.headers.get("content-type"),
            r.body instanceof ReadableStream,
            r.bodyUsed,
            Object.getOwnPropertyNames(r).length,
          );
          try {
            r.headers.set("x-page", "1");
            shape.push("headers mutable");
          } catch (e) {
            shape.push(e.name + ":" + e.message);
          }
          try {
            r.headers.delete("content-type");
            shape.push("headers deletable");
          } catch (e) {
            shape.push(e.name + ":" + e.message);
          }
          var c = r.clone();
          shape.push(
            c.url === r.url,
            c.type,
            c.redirected,
            c.headers !== r.headers,
            c.headers.get("content-type"),
          );
          try {
            c.headers.append("x-page", "1");
            shape.push("clone headers mutable");
          } catch (e) {
            shape.push(e.name);
          }
          try {
            var byob = c.body.getReader({ mode: "byob" });
            byob.releaseLock();
            shape.push("byob");
          } catch (e) {
            shape.push("no byob:" + e.name);
          }
          return c.text().then(function (t) {
            shape.push(t);
            return r.json();
          });
        })
        .then(function (j) {
          shape.push(j.value);
          // HEAD has no body: the platform's Response comes through as is.
          return fetch("/api/data", { method: "HEAD" });
        })
        .then(function (h) {
          shape.push(h.status, h.body === null);
          return fetch("/api/data");
        })
        .then(function (r) {
          return r.json().then(function () {
            return r.text().then(
              function () {
                shape.push("read twice");
              },
              function (e) {
                shape.push(e.name, r.bodyUsed);
              },
            );
          });
        })
        .then(function () {
          slot("shape", JSON.stringify(shape));
          done();
        });
    },

    // A body the page stops reading and then aborts: the platform errors
    // the body at once, so the reader's closed promise rejects with no read
    // pending, and a later read fails the same way.
    "fetch-abort": function () {
      var ac = new AbortController();
      fetch("/api/stream?n=forever&interval=50", { signal: ac.signal }).then(
        function (r) {
          var reader = r.body.getReader();
          return reader.read().then(function (first) {
            slot("first", decoder.decode(first.value));
            ac.abort();
            var timer = setTimeout(function () {
              slot("closed", "still pending");
              done();
            }, 2000);
            return reader.closed.then(
              function () {
                slot("closed", "resolved");
              },
              function (e) {
                clearTimeout(timer);
                slot("closed", e.name);
                return reader.read().then(
                  function () {
                    slot("read", "ok");
                    done();
                  },
                  function (e2) {
                    slot("read", e2.name);
                    done();
                  },
                );
              },
            );
          });
        },
      );
    },

    // An XMLHttpRequest whose body arrives in three pieces: the page sees
    // each piece at readyState 3 (LOADING) before the response is done.
    "xhr-stream": function () {
      var x = new XMLHttpRequest();
      var states = [];
      x.open("GET", "/api/stream?n=3&interval=100");
      x.onreadystatechange = function () {
        if (x.readyState === 3) {
          states.push("3:" + JSON.stringify(x.responseText));
          window.__readAt = Date.now();
        } else {
          states.push(String(x.readyState));
        }
      };
      x.onload = function () {
        slot("states", states.join("|"));
        slot("text", JSON.stringify(x.responseText));
        done();
      };
      x.send();
    },

    // An XMLHttpRequest whose body arrives in many small pieces, faster
    // than the platform's 50 ms progress rate limit, so some progress events
    // are deferred to a task of their own. Every readystatechange and
    // progress listener notes what the page could read (its responseText
    // length) and reads the clock.
    "xhr-progress": function () {
      var x = new XMLHttpRequest();
      var seen = [];
      function note(e) {
        seen.push(e.type + ":" + x.readyState + ":" + x.responseText.length);
        Date.now();
      }
      x.open("GET", "/api/stream?n=40&interval=5");
      x.addEventListener("readystatechange", note);
      x.onprogress = note;
      x.onloadend = function () {
        slot("seen", seen.join("|"));
        done();
      };
      x.send();
    },

    // An upload with listeners at the upload object, one added with
    // addEventListener and the rest as handlers. Each listener reads the
    // clock.
    "xhr-upload": function () {
      var x = new XMLHttpRequest();
      var seen = [];
      function note(e) {
        seen.push("upload:" + e.type);
        Date.now();
      }
      x.open("POST", "/api/data");
      x.upload.addEventListener("progress", note);
      x.upload.onloadstart = note;
      x.upload.onload = note;
      x.upload.onloadend = note;
      x.onload = function () {
        seen.push("load:" + x.status);
        Date.now();
      };
      x.onloadend = function () {
        slot("seen", seen.join("|"));
        done();
      };
      x.send("u".repeat(2 * 1024 * 1024));
    },

    // A cross-origin POST of a CORS-safelisted kind with no upload listener:
    // a simple request, sent without a preflight. The other server sends no
    // CORS headers, so the page sees a network error either way.
    "xhr-cross-origin": function () {
      var x = new XMLHttpRequest();
      x.open("POST", params.get("other") + "/api/echo");
      x.onloadend = function () {
        slot("status", x.status);
        done();
      };
      x.send("cross");
    },

    // An EventSource on a stream that never ends: two events, then close.
    sse: function () {
      var es = new EventSource("/api/sse?n=forever&interval=100");
      var got = [];
      es.onmessage = function (e) {
        got.push(e.data);
        window.__readAt = Date.now();
        if (got.length === 2) {
          es.close();
          slot("events", got.join("|"));
          done();
        }
      };
    },

    // Two XMLHttpRequests that fail: one times out, one cannot connect.
    "xhr-failures": function () {
      var pending = 2;
      function finish() {
        if (--pending === 0) done();
      }
      var slow = new XMLHttpRequest();
      slow.open("GET", "/api/slow?ms=3000");
      slow.timeout = 200;
      slow.ontimeout = function () {
        slot("slow", "timeout," + slow.status);
        finish();
      };
      slow.onerror = function () {
        slot("slow", "error," + slow.status);
        finish();
      };
      var refused = new XMLHttpRequest();
      // Port 1 on the loopback interface refuses the connection at once.
      refused.open("GET", "http://127.0.0.1:1/");
      refused.timeout = 5000;
      refused.ontimeout = function () {
        slot("refused", "timeout," + refused.status);
        finish();
      };
      refused.onerror = function () {
        slot("refused", "error," + refused.status);
        finish();
      };
      slow.send();
      refused.send();
    },

    // An upload that times out while its body is still being sent (the
    // server never reads it): the platform fires timeout at the upload
    // object first, then at the request.
    "xhr-upload-timeout": function () {
      var seen = [];
      var x = new XMLHttpRequest();
      x.open("POST", "/api/stall");
      x.timeout = 300;
      x.upload.ontimeout = function (e) {
        seen.push("upload:" + e.type);
        Date.now();
      };
      x.ontimeout = function (e) {
        seen.push(e.type);
      };
      x.onloadend = function () {
        slot("seen", seen.join("|"));
        done();
      };
      x.send("v".repeat(16 * 1024 * 1024));
    },

    // send() calls the platform refuses, and a GET whose body it ignores.
    "xhr-unsent": function () {
      var results = [];
      var unopened = new XMLHttpRequest();
      try {
        unopened.send("never");
        results.push("sent");
      } catch (e) {
        results.push(e.name);
      }
      var twice = new XMLHttpRequest();
      twice.open("POST", "/api/echo");
      twice.send("one");
      try {
        twice.send("two");
        results.push("sent twice");
      } catch (e) {
        results.push(e.name);
      }
      twice.onload = function () {
        results.push(twice.responseText);
        var get = new XMLHttpRequest();
        get.open("GET", "/api/data?get-with-body=1");
        get.onload = function () {
          results.push(JSON.parse(get.responseText).value);
          slot("results", results.join(","));
          done();
        };
        get.send("ignored by the platform");
      };
    },
  };

  cases[params.get("case")]();
})();
