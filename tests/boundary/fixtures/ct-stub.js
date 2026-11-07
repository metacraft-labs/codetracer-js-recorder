// The fixture page of the stub test: count from here on, and send the stub's
// daemon socket to the fixture server (which does not upgrade it). The page
// itself registers no timer and opens no socket: every TaskReg, Task or
// NetRequest in the log would be the stub's.
(function () {
  if (window.__pageCounts) window.__pageCounts.enabled = true;
  window.__codetracer_endpoint = "ws://" + location.host + "/ct-stream";
})();
