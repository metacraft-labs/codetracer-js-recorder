// The fixture page of the storage test in
// tests/boundary/record-shim-fidelity.test.ts: Web Storage read and written
// the property way (`localStorage.a`, `localStorage.b = …`, `delete`, `in`,
// `Object.keys`, `for…in`, `JSON.stringify`) as well as through its
// methods, plus the identity checks a page may make of the storage object.
// Every result goes into the `r-results` slot, in order, as JSON.
(function () {
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

  // A storage event caused by another page of the same origin.
  window.addEventListener("storage", function (e) {
    slot(
      "event",
      [e.key, e.newValue, e.storageArea === localStorage].join(","),
    );
  });

  localStorage.clear();
  sessionStorage.clear();
  var r = [];
  localStorage.setItem("a", "1");
  r.push(localStorage.a);
  r.push(String(localStorage.missing));
  r.push(localStorage["a"]);
  r.push("a" in localStorage, "zz" in localStorage, "getItem" in localStorage);
  localStorage.b = "2";
  r.push(localStorage.getItem("b"));
  localStorage["c"] = 3;
  r.push(Object.keys(localStorage).sort().join(" "));
  r.push(localStorage.length);
  r.push(typeof localStorage.key(0), localStorage.key(99));
  delete localStorage.b;
  r.push(localStorage.getItem("b"), "b" in localStorage);
  r.push(
    localStorage.getItem === Storage.prototype.getItem,
    localStorage instanceof Storage,
    Object.prototype.toString.call(localStorage),
    localStorage === window.localStorage,
    localStorage.constructor === Storage,
    localStorage.hasOwnProperty("a"),
    Object.getOwnPropertyDescriptor(localStorage, "a").value,
    Storage.prototype.getItem.call(localStorage, "a"),
  );
  // A key that a Storage method also names is stored, not assigned; which
  // of the two a property read then finds is the platform's business
  // (Chromium: the stored value).
  localStorage.getItem = "shadow";
  r.push(
    typeof localStorage.getItem,
    Storage.prototype.getItem.call(localStorage, "getItem"),
  );
  delete localStorage.getItem;
  r.push(typeof localStorage.getItem);
  var names = [];
  for (var k in localStorage) {
    if (Object.prototype.hasOwnProperty.call(localStorage, k)) names.push(k);
  }
  r.push(names.sort().join(" "));
  r.push(JSON.stringify(localStorage));
  try {
    Object.preventExtensions(localStorage);
    r.push("prevented");
  } catch (e) {
    r.push(e.name);
  }
  try {
    Object.defineProperty(localStorage, "acc", {
      get: function () {
        return 1;
      },
    });
    r.push("accessor defined");
  } catch (e) {
    r.push(e.name);
  }
  sessionStorage.s = "x";
  r.push(sessionStorage.s, sessionStorage.length);
  var ev = new StorageEvent("storage", { key: "k", storageArea: localStorage });
  r.push(ev.storageArea === localStorage);
  slot("results", JSON.stringify(r));
  document.body.setAttribute("data-done", "1");
})();
