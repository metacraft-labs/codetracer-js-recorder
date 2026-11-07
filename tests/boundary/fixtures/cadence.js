// The fixture page of the checkpoint-cadence test: one click on #go runs
// three tasks of 150 reads each (so a checkpoint falls due by record count,
// §7.3: every 256 records) and then a chain of six timers 500 ms apart that
// each read the clock once (so one falls due by recorded time: every 2 s).
// Each task changes the DOM, so consecutive checkpoints differ.
(function () {
  var total = 0;
  function burst() {
    for (var i = 0; i < 150; i++) total += Math.random();
    document.getElementById("count").textContent = String(total > 0);
  }
  function chain(left) {
    document.getElementById("time").textContent = String(Date.now());
    if (left > 0) {
      setTimeout(function () {
        chain(left - 1);
      }, 500);
    } else {
      document.body.setAttribute("data-done", "1");
    }
  }
  document.getElementById("go").addEventListener("click", function () {
    setTimeout(burst, 0);
    setTimeout(burst, 0);
    setTimeout(burst, 0);
    setTimeout(function () {
      chain(6);
    }, 0);
  });
})();
