module.exports = {
  compute: (n) => n * 2,
  transform: (value, n) => value + n,
  aggregate: (history) => history.reduce((a, b) => a + b, 0),
};
