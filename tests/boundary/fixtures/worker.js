// The worker refused.js starts: it answers each number with that number + 1.
self.onmessage = function (e) {
  self.postMessage(e.data + 1);
};
