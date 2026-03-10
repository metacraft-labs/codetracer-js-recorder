/**
 * Loops and conditionals example.
 */
function sumRange(start, end) {
  var total = 0;
  for (var i = start; i <= end; i++) {
    total = total + i;
  }
  return total;
}

function countDown(n) {
  var steps = [];
  while (n > 0) {
    if (n % 2 === 0) {
      steps.push(n + " (even)");
    } else {
      steps.push(n + " (odd)");
    }
    n--;
  }
  return steps;
}

function classify(values) {
  var result = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v < 0) {
      result.push("negative");
    } else if (v === 0) {
      result.push("zero");
    } else {
      result.push("positive");
    }
  }
  return result;
}

var rangeSum = sumRange(1, 10);
console.log("sum 1..10:", rangeSum);

var steps = countDown(5);
console.log("countdown:", steps);

var classified = classify([-3, 0, 7, -1, 4]);
console.log("classified:", classified);
