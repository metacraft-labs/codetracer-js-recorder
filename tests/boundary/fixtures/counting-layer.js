// Installed by the test with page.addInitScript, so it runs before every
// script of the page, the boundary shim's bootstrap included. It wraps each
// read the fixture makes with a counter and leaves the wrapped function in
// place; the shim then captures these wrappers as its originals. Every read
// that reaches the platform through the shim is therefore counted once,
// and a read the shim did not log still shows up here.
//
// Counting is off until the page's own script turns it on
// (`__pageCounts.enabled = true`), so what is counted is the page's reads
// and anything the recorder does while the page runs.
(function () {
  var counts = {
    enabled: false,
    dateNow: 0,
    performanceNow: 0,
    mathRandom: 0,
    getRandomValues: 0,
    fetch: 0,
    xhr: 0,
    setTimeout: 0,
    setInterval: 0,
    requestAnimationFrame: 0,
    localStorage: 0,
    getBoundingClientRect: 0,
    webSocket: 0,
    timeStamp: 0,
  };
  Object.defineProperty(window, "__pageCounts", { value: counts });

  function wrap(owner, name, key, when) {
    var original = owner[name];
    owner[name] = function () {
      if (counts.enabled && (!when || when(this))) counts[key]++;
      return original.apply(this, arguments);
    };
  }
  wrap(Date, "now", "dateNow");
  wrap(Performance.prototype, "now", "performanceNow");
  wrap(Math, "random", "mathRandom");
  wrap(Crypto.prototype, "getRandomValues", "getRandomValues");
  wrap(window, "fetch", "fetch");
  wrap(XMLHttpRequest.prototype, "send", "xhr");
  wrap(window, "setTimeout", "setTimeout");
  wrap(window, "setInterval", "setInterval");
  wrap(window, "requestAnimationFrame", "requestAnimationFrame");
  // The storage object as the platform made it: the shim hands the page a
  // proxy of it, and unwraps the proxy before calling getItem.
  var local = window.localStorage;
  wrap(Storage.prototype, "getItem", "localStorage", function (self) {
    return self === local;
  });
  wrap(Element.prototype, "getBoundingClientRect", "getBoundingClientRect");

  var stamp = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp");
  Object.defineProperty(Event.prototype, "timeStamp", {
    get: function () {
      if (counts.enabled) counts.timeStamp++;
      return stamp.get.call(this);
    },
    enumerable: stamp.enumerable,
    configurable: true,
  });

  var OriginalWebSocket = window.WebSocket;
  var CountingWebSocket = function (url, protocols) {
    if (counts.enabled) counts.webSocket++;
    return protocols === undefined
      ? new OriginalWebSocket(url)
      : new OriginalWebSocket(url, protocols);
  };
  CountingWebSocket.prototype = OriginalWebSocket.prototype;
  Object.setPrototypeOf(CountingWebSocket, OriginalWebSocket);
  window.WebSocket = CountingWebSocket;
})();
