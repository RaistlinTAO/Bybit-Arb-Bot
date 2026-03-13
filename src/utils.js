const Decimal = require('decimal.js');

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_DOWN,
  toExpNeg: -30,
  toExpPos: 30,
});

function D(value = 0) {
  return new Decimal(value ?? 0);
}

function decimalPlaces(value) {
  const text = String(value || '0').toLowerCase();
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const parts = text.split('.');
  return parts[1] ? parts[1].length : 0;
}

function floorToStep(value, step) {
  const s = D(step);
  if (s.lte(0)) throw new Error(`Invalid step: ${step}`);
  return D(value).div(s).floor().mul(s);
}

function clampNonNegative(value) {
  return Decimal.max(D(value), D(0));
}

function formatDecimal(value, stepOrDp = 8) {
  const dp = typeof stepOrDp === 'number' ? stepOrDp : decimalPlaces(stepOrDp);
  return D(value).toFixed(dp).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return Date.now();
}

function uniq(strings) {
  return [...new Set(strings.map(String))];
}

module.exports = {
  D,
  clampNonNegative,
  decimalPlaces,
  floorToStep,
  formatDecimal,
  sleep,
  now,
  uniq,
};
