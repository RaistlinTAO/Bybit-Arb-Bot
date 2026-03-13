const { sleep, now } = require('./utils');

class RollingRateLimiter {
  constructor(limits) {
    this.limits = limits;
    this.history = new Map();
  }

  async acquire(key) {
    const config = this.limits[key];
    if (!config) return;

    const windowMs = config.windowMs;
    const max = config.max;
    const timestamps = this.history.get(key) || [];

    while (true) {
      const cutoff = now() - windowMs;
      while (timestamps.length && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length < max) {
        timestamps.push(now());
        this.history.set(key, timestamps);
        return;
      }
      const waitMs = Math.max(5, timestamps[0] + windowMs - now());
      await sleep(waitMs);
    }
  }
}

module.exports = {
  RollingRateLimiter,
};
