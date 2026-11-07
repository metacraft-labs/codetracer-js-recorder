// The fixture page of jsbound_shim_refuses_out_of_scope_features: one click
// on #go uses every feature V1 refuses (JS-Boundary-Recording.md §7.5), each
// TWICE (so "one Refusal per feature" is tested, not "one per use"), and
// writes the result each produced into its slot, so the test can see that
// the page kept working.
(function () {
  window.__errors = { error: 0, rejection: 0 };
  window.addEventListener("error", function () {
    window.__errors.error++;
  });
  window.addEventListener("unhandledrejection", function () {
    window.__errors.rejection++;
  });

  function show(label, value) {
    document.getElementById("r-" + label).textContent = label + "=" + value;
  }
  var pending = 0;
  function begin() {
    pending++;
  }
  function finish() {
    pending--;
    if (pending === 0) document.body.setAttribute("data-done", "1");
  }

  // (module (func (export "add") (param i32 i32) (result i32)
  //   local.get 0 local.get 1 i32.add))
  var ADD_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60,
    0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01,
    0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20,
    0x00, 0x20, 0x01, 0x6a, 0x0b,
  ]);

  document.getElementById("go").addEventListener("click", function () {
    begin();
    var replies = 0;
    [new Worker("worker.js"), new Worker("worker.js")].forEach(function (w) {
      w.onmessage = function (e) {
        replies += e.data;
        if (replies === 2 * 42) {
          show("worker", replies);
          finish();
        }
      };
      w.postMessage(41);
    });

    begin();
    WebAssembly.instantiate(ADD_WASM).then(function (first) {
      return WebAssembly.instantiate(ADD_WASM).then(function (second) {
        show(
          "wasm",
          first.instance.exports.add(2, 3) + second.instance.exports.add(4, 5),
        );
        finish();
      });
    });

    begin();
    var sender = new BroadcastChannel("ct-boundary-test");
    var receiver = new BroadcastChannel("ct-boundary-test");
    receiver.onmessage = function (e) {
      show("broadcast", e.data);
      sender.close();
      receiver.close();
      finish();
    };
    sender.postMessage("hello");

    begin();
    var opened = 0;
    [indexedDB.open("ct-boundary-a"), indexedDB.open("ct-boundary-b")].forEach(
      function (req) {
        req.onsuccess = function () {
          req.result.close();
          if (++opened === 2) {
            show("idb", opened);
            finish();
          }
        };
      },
    );

    var target = { v: 7 };
    var ref = new WeakRef(target);
    show("weakref", ref.deref().v + ref.deref().v);

    var registry = new FinalizationRegistry(function () {});
    var registry2 = new FinalizationRegistry(function () {});
    registry.register({}, "a");
    registry2.register({}, "b");
    show("finalization", "registered");
  });
})();
