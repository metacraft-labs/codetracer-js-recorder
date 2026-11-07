// The fixture page of tests/boundary/replay-resources.test.ts: the events of
// resource elements (an image, a style sheet, a frame, a media element), a
// dynamic import() and a script the page inserts, each racing a task of the
// page's own, so the order the page saw is the order it writes into
// `<li id="r-order">`. `?case=<name>` picks one scenario; `delay=<ms>` slows
// the resource down on record (the fixture server's `delay` parameter). The
// page sets `<body data-ready="1">` once it listens and `data-done="1"` when
// it is finished.
(function () {
  var params = new URLSearchParams(location.search);
  var delay = Number(params.get("delay") || "0");
  var out = document.getElementById("out");
  var host = document.getElementById("host");
  var order = [];
  function slot(name, value) {
    var li = document.getElementById("r-" + name);
    if (li === null) {
      li = document.createElement("li");
      li.id = "r-" + name;
      out.appendChild(li);
    }
    li.textContent = name + "=" + value;
  }
  function saw(what) {
    order.push(what);
    slot("order", order.join(","));
  }
  function ready() {
    document.body.setAttribute("data-ready", "1");
  }
  function done() {
    document.body.setAttribute("data-done", "1");
  }
  function when(n, f) {
    return function () {
      if (order.length === n) f();
    };
  }
  var slow = delay > 0 ? "?delay=" + delay : "";

  var cases = {
    // An image whose load races the user's click.
    image: function () {
      var img = document.createElement("img");
      img.id = "pic";
      img.addEventListener("load", function (e) {
        saw("img:" + e.isTrusted + ":" + img.complete + ":" + img.naturalWidth);
        if (order.length === 3) done();
      });
      img.src = "slow-load-pixel.svg" + slow;
      host.appendChild(img);
      document.getElementById("btn").addEventListener("click", function () {
        saw("click");
        // A second image, which loads at once; whether the first had
        // arrived by then is the platform's state, which only the runner's
        // holding of the first image's request keeps as on record.
        var dot = new Image();
        dot.onload = function () {
          saw("dot:" + img.complete);
          if (order.length === 3) done();
        };
        dot.src = "resources-dot.svg";
      });
      ready();
    },

    // A style sheet's load, an image's error and a timer, in the order the
    // network decided; and an image whose load needs no request (a data:
    // URL), with a handler set by markup that checks the event is trusted.
    sheet: function () {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "slow-load.css" + slow;
      link.onload = function (e) {
        saw("css:" + e.isTrusted + ":" + (link.sheet !== null));
        finish();
      };
      document.head.appendChild(link);
      var bad = new Image();
      bad.onerror = function (e) {
        saw("error:" + e.isTrusted);
        finish();
      };
      bad.src = "missing.png" + slow;
      host.insertAdjacentHTML(
        "beforeend",
        '<img id="inline" onload="window.__inlineSaw = event.isTrusted; this.setAttribute(\'data-loaded\', String(event.isTrusted))" ' +
          "src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='3' height='3'/%3E\">",
      );
      setTimeout(function () {
        saw("timer");
        finish();
      }, 30);
      function finish() {
        if (order.length === 3) {
          setTimeout(function () {
            slot("inline", String(window.__inlineSaw));
            done();
          }, 50);
        }
      }
    },

    // A frame of the page: its load and what the page reads of it.
    frame: function () {
      var f = document.createElement("iframe");
      f.src = params.get("frame") || "resources-frame.html" + slow;
      f.onload = function (e) {
        var title;
        try {
          title = f.contentDocument.title;
        } catch (err) {
          title = "cross-origin";
        }
        saw("frame:" + e.isTrusted + ":" + title);
        if (order.length === 2) done();
      };
      host.appendChild(f);
      setTimeout(function () {
        saw("timer");
        if (order.length === 2) done();
      }, 30);
    },

    // A media element: its events and the state its listeners read, one
    // of them a handler set by markup that checks the event is trusted.
    media: function () {
      host.insertAdjacentHTML(
        "beforeend",
        '<audio id="snd" preload="auto" oncanplay="window.__canplaySaw = event.isTrusted"></audio>',
      );
      var a = document.getElementById("snd");
      a.addEventListener("loadedmetadata", function (e) {
        saw(
          "meta:" +
            e.isTrusted +
            ":" +
            a.duration.toFixed(2) +
            ":" +
            a.readyState +
            ":" +
            a.paused,
        );
      });
      a.addEventListener("canplaythrough", function () {
        saw("ready:" + a.buffered.length + ":" + (a.buffered.end(0) > 0));
        slot("markup", String(window.__canplaySaw));
        a.play().then(
          function () {
            saw("played");
            a.pause();
            done();
          },
          function (err) {
            saw("refused:" + err.name);
            done();
          },
        );
      });
      a.src = "resources-tone.wav" + slow;
      setTimeout(function () {
        saw("timer");
      }, 30);
    },

    // A dynamic import, whose module reads the clock while it evaluates;
    // an image and a timer load and run before it does.
    import: function () {
      var img = new Image();
      img.onload = function () {
        saw("img");
      };
      img.src = "slow-load-pixel.svg";
      setTimeout(function () {
        saw("timer:" + (Date.now() > 0));
      }, 30);
      import("./resources-mod.js" + slow).then(function (m) {
        saw("import:" + m.value);
        setTimeout(done, 50);
      });
    },

    // A script the page inserts that arrives after the session ends.
    late: function () {
      var s = document.createElement("script");
      s.src = "resources-late.js?delay=" + (params.get("late") || "4000");
      document.head.appendChild(s);
      saw("inserted");
      done();
    },
  };

  window.addEventListener("load", function () {
    cases[params.get("case")]();
  });
})();
