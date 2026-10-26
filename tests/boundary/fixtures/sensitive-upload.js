// Sensitive inputs and scrubbing as they are uploaded (CodeTracer's
// JS-Boundary-Recording specification §11.3), recorded with the shim
// uploading to a stub ingest by tests/boundary/sensitive.test.ts. The page's
// query names the case:
//
// - fields: `send` posts the password and the card number in a JSON body
//   and the undeclared field's value in a query string;
// - headers: `send` fetches a route whose response carries credential
//   headers, with an `Authorization` header and a cookie of its own and a
//   JWT in the query, then pushes a URL with another JWT in its query;
// - error: `send` raises an error whose message holds an e-mail address and
//   a number, in a timer;
// - optout (no `send`): the page declares `pub` public and tries to declare
//   two credential fields public, noting whether each call threw;
// - shadow: fields the window's listeners see only through shadow trees (a
//   password in an open shadow root, an undeclared text field in a closed
//   one, its element left on `__closedInput` for the test to focus), an
//   undeclared and a public `contenteditable` region, a text field whose
//   value the page mirrors into its `value` attribute and a `textarea` whose
//   value it mirrors into its default value (as frameworks keep controlled
//   fields), all under a `MutationObserver` with old values; `send` fetches
//   a URL with the region's text and raises an error quoting the mirrored
//   field's value, unquoted, in a timer. The URL also carries the values of
//   the two fields behind shadow roots.
(function () {
  var kase = new URLSearchParams(location.search).get("case");
  // Credential-shaped tokens (JWTs, RFC 7519) the page puts in URLs.
  var jwt2 = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0d28ifQ.c2lnbmF0dXJlLXR3by14eXo";
  var jwt3 =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0aHJlZSJ9.c2lnbmF0dXJlLXRocmVlLXE";
  var $ = function (id) {
    return document.getElementById(id);
  };
  var done = function () {
    document.body.setAttribute("data-done", "1");
  };
  ct.sensitive($("cs"));
  ct.public($("pub"));
  window.__publicThrew = {};
  ["pw2", "otp"].forEach(function (id) {
    try {
      ct.public($(id));
      window.__publicThrew[id] = false;
    } catch (e) {
      window.__publicThrew[id] = e instanceof TypeError;
    }
  });
  if (kase === "shadow") {
    var extra = $("extra");
    var openHost = document.createElement("x-open");
    openHost.id = "openhost";
    var openRoot = openHost.attachShadow({ mode: "open" });
    openRoot.innerHTML = '<input id="spw" type="password">';
    var closedHost = document.createElement("x-closed");
    closedHost.id = "closedhost";
    var closedRoot = closedHost.attachShadow({ mode: "closed" });
    closedRoot.innerHTML = '<input type="text">';
    window.__closedInput = closedRoot.querySelector("input");
    var ed = document.createElement("div");
    ed.id = "ed";
    ed.contentEditable = "true";
    var edpub = document.createElement("div");
    edpub.id = "edpub";
    edpub.contentEditable = "true";
    edpub.setAttribute("data-ct-public", "");
    var mir = document.createElement("input");
    mir.id = "mir";
    mir.addEventListener("input", function () {
      mir.setAttribute("value", mir.value);
    });
    var ta = document.createElement("textarea");
    ta.id = "ta";
    ta.addEventListener("input", function () {
      ta.defaultValue = ta.value;
    });
    extra.append(openHost, closedHost, ed, edpub, mir, ta);
    window.__mutations = 0;
    new MutationObserver(function (records) {
      window.__mutations += records.length;
    }).observe(extra, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeOldValue: true,
    });
  }
  $("send").addEventListener("click", function () {
    if (kase === "shadow") {
      var openInput = openRoot.querySelector("input");
      fetch(
        "/api/data?e=" +
          encodeURIComponent($("ed").textContent) +
          "&o=" +
          encodeURIComponent(openInput.value) +
          "&c=" +
          encodeURIComponent(window.__closedInput.value),
      ).then(function () {
        setTimeout(function () {
          done();
          throw new Error("rejected " + $("mir").value);
        }, 0);
      });
    } else if (kase === "fields") {
      Promise.all([
        fetch("/api/data", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pw: $("pw").value, cc: $("cc").value }),
        }),
        fetch("/api/data?q=" + encodeURIComponent($("plain").value)),
      ]).then(function () {
        $("status").textContent = "sent";
        done();
      });
    } else if (kase === "headers") {
      document.cookie = "sid=cookie-val-5544e1; path=/";
      fetch("/api/headers?token=" + jwt2, {
        headers: { authorization: "Bearer req-authz-91c3d7" },
        credentials: "same-origin",
      }).then(function (r) {
        var names = [];
        r.headers.forEach(function (_v, k) {
          names.push(k);
        });
        $("status").textContent = names.length + " headers";
        history.pushState(null, "", "?case=headers&jwt=" + jwt3);
        done();
      });
    } else if (kase === "error") {
      setTimeout(function () {
        done();
        throw new Error("Login failed for ada@example.com after 3 attempts");
      }, 0);
    }
  });
})();
