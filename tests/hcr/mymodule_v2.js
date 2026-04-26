module.exports = {
  compute: (n) => n * 3,
  transform: (value, n) => value - n,
  aggregate: (history) => Math.max(...history, 0),
};
