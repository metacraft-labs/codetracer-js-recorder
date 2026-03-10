/**
 * Multiple functions with various call patterns.
 */
function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}

function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

function main() {
  var sum = add(3, 4);
  var product = multiply(5, 6);
  var fact5 = factorial(5);
  console.log("sum:", sum);
  console.log("product:", product);
  console.log("factorial(5):", fact5);
  return { sum: sum, product: product, fact5: fact5 };
}

main();
