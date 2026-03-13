const rk = require('rklogger');

function pick(name, fallback) {
  return typeof rk?.[name] === 'function' ? rk[name] : fallback;
}

const rawInfo = pick('printInfo', (...args) => console.log(...args));
const rawError = pick('printError', (...args) => console.error(...args));
const rawWarn = pick('printWarning', (...args) => console.warn(...args));
const rawDebug = pick('printDebug', (...args) => console.debug(...args));
const rawGeneral = pick('printGeneral', (...args) => console.log(...args));

const LOG_FLAGS = {
  printDebug: ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.PRINT_DEBUG || '').trim().toLowerCase()),
  printStackDetail: ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.PRINT_STACK_DETAIL || '').trim().toLowerCase()),
  locale: String(process.env.CONSOLE_LOCALE || 'en-GB').trim() || 'en-GB',
  timezone: String(process.env.CONSOLE_TIMEZONE || 'Australia/Melbourne').trim() || 'Australia/Melbourne',
  supportMilliseconds: ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.SUPPORT_MILLISECONDS || '').trim().toLowerCase()),
};

function buildTimestamp() {
  const date = new Date();
  const base = {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: LOG_FLAGS.timezone,
  };

  const opts = LOG_FLAGS.supportMilliseconds
    ? { ...base, fractionalSecondDigits: 3 }
    : base;

  try {
    return new Intl.DateTimeFormat(LOG_FLAGS.locale, opts).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat('en-GB', opts).format(date);
    } catch {
      return date.toISOString();
    }
  }
}

function prefixLine(line) {
  return `[${buildTimestamp()}] ${line}`;
}

function clip(text, max = 240) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
}

function shortJson(value, max = 160) {
  try {
    return clip(JSON.stringify(value), max);
  } catch {
    return clip(String(value), max);
  }
}

function flatten(value, prefix = '', depth = 0, maxDepth = 2, out = []) {
  if (value === undefined) return out;
  if (isPrimitive(value)) {
    out.push([prefix || 'value', String(value)]);
    return out;
  }

  if (Array.isArray(value)) {
    if (!prefix) {
      out.push(['items', shortJson(value)]);
      return out;
    }
    if (value.length === 0) {
      out.push([prefix, '[]']);
      return out;
    }
    if (value.length <= 4 && value.every((item) => isPrimitive(item))) {
      out.push([prefix, value.join(',')]);
      return out;
    }
    out.push([prefix, shortJson(value)]);
    return out;
  }

  if (depth >= maxDepth) {
    out.push([prefix || 'value', shortJson(value)]);
    return out;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    out.push([prefix || 'value', '{}']);
    return out;
  }

  for (const [key, child] of entries) {
    flatten(child, prefix ? `${prefix}.${key}` : key, depth + 1, maxDepth, out);
  }
  return out;
}

function toLine(message, payload) {
  if (payload === undefined) return message;
  if (typeof payload === 'string') return `${message} ${payload}`;

  const parts = flatten(payload)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${clip(value)}`);

  if (parts.length === 0) return message;
  return `${message} ${parts.join(' ')}`;
}

function write(fn, message, payload) {
  const line = prefixLine(toLine(message, payload));
  fn(line);
}

function normalizeError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error.body?.retMsg) return `${error.body.retMsg} (code=${error.body.retCode ?? 'unknown'})`;
  if (error.response?.data?.retMsg) {
    return `${error.response.data.retMsg} (code=${error.response.data.retCode ?? 'unknown'})`;
  }
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function enrichErrorPayload(payload) {
  if (!LOG_FLAGS.printStackDetail) return payload;
  if (payload instanceof Error) {
    return { message: payload.message, stack: payload.stack };
  }
  return payload;
}

function info(message, payload) {
  write(rawInfo, message, payload);
}

function warn(message, payload) {
  write(rawWarn, message, payload);
}

function error(message, payload) {
  write(rawError, message, enrichErrorPayload(payload));
}

function debug(message, payload) {
  if (!LOG_FLAGS.printDebug) return;
  write(rawDebug, message, payload);
}

function general(message, payload) {
  write(rawGeneral, message, payload);
}

function formatOrderShort(order) {
  if (!order) return '';
  const side = String(order.side || '').slice(0, 1).toUpperCase();
  const price = order.price || '?';
  const qty = order.leavesQty || order.qty || '?';
  const status = order.orderStatus || '';
  return `${side}@${price}x${qty}${status ? `(${status})` : ''}`;
}

module.exports = {
  info,
  warn,
  error,
  debug,
  general,
  normalizeError,
  formatOrderShort,
  toLine,
  LOG_FLAGS,
};
