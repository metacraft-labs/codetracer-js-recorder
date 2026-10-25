// Requests a page makes from a realm the generic shim does not patch: a
// same-origin frame's own globals (`frame.contentWindow.fetch`, its
// `XMLHttpRequest`, `EventSource`, `WebSocket`, a dedicated `Worker` made
// there, and its `RTCPeerConnection`). The shim installs into the page's top
// document only, so none of them is a boundary read it logs, and on replay
// the runner must still let none of them reach the network
// (JS-Boundary-Recording §7.4). The origin the HTTP and socket requests go
// to is the page's `?second=` parameter; the STUN server the peer connection
// asks for its address is `?stun=<host>:<port>` (UDP, which no HTTP proxy
// sees). The page makes them in a timer task after the document is parsed,
// writes what it tried into `#out`, and sets `<body data-done="1">` once a
// later timer has run.
"use strict";
(function () {
  var out = document.getElementById("out");
  function slot(text) {
    var li = document.createElement("li");
    li.textContent = text;
    out.appendChild(li);
  }
  function attempt(name, fn) {
    try {
      fn();
      slot(name);
    } catch (e) {
      slot(name + " threw");
    }
  }
  var params = new URLSearchParams(location.search);
  var second = params.get("second") || "";
  var stun = params.get("stun") || "";
  setTimeout(function () {
    // Into a container the parser has already closed: appended to the body,
    // the frame would land before or after the body's trailing text
    // depending on how far the parser got when the timer ran, which the
    // replay does not hold back.
    var frame = document.createElement("iframe");
    document.getElementById("frames").appendChild(frame);
    var realm = frame.contentWindow;
    if (second !== "") {
      var ws = second.replace(/^http/, "ws");
      attempt("fetch", function () {
        realm.fetch(second + "/realm-fetch").catch(function () {});
      });
      attempt("socket", function () {
        new realm.WebSocket(ws + "/realm-socket");
      });
      attempt("xhr", function () {
        var xhr = new realm.XMLHttpRequest();
        xhr.open("GET", second + "/realm-xhr");
        xhr.send();
      });
      attempt("events", function () {
        new realm.EventSource(second + "/realm-events");
      });
      attempt("worker", function () {
        var source =
          "fetch(" +
          JSON.stringify(second + "/realm-worker-fetch") +
          ").catch(function () {});" +
          "new WebSocket(" +
          JSON.stringify(ws + "/realm-worker-socket") +
          ");";
        var url = realm.URL.createObjectURL(
          new realm.Blob([source], { type: "text/javascript" }),
        );
        new realm.Worker(url);
      });
    }
    if (stun !== "") {
      attempt("rtc", function () {
        var pc = new realm.RTCPeerConnection({
          iceServers: [{ urls: "stun:" + stun }],
        });
        pc.createDataChannel("probe");
        pc.createOffer()
          .then(function (offer) {
            return pc.setLocalDescription(offer);
          })
          .catch(function () {});
      });
    }
    setTimeout(function () {
      document.body.setAttribute("data-done", "1");
    }, 300);
  }, 0);
})();
