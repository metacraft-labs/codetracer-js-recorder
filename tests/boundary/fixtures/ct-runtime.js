// The fixture page of jsbound_ct_runtime_uses_captured_originals: install
// the browser __ct runtime as an instrumented bundle would, and emit a few
// events so its flush timer arms. The page itself registers no timer and
// opens no socket: every TaskReg, Task or NetRequest in the log would be the
// runtime's.
(function () {
  if (window.__pageCounts) window.__pageCounts.enabled = true;
  var ct = CtRuntimeBrowser.installBrowserRuntime({
    endpoint: "ws://" + location.host + "/ct-stream",
    flushIntervalMs: 20,
  });
  for (var i = 0; i < 5; i++) ct.step(i);
  document.getElementById("status").textContent = "running";
})();
