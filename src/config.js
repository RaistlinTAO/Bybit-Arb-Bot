const path = require('path');
const { D } = require('./utils');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function stringValue(value, fallback) {
  return String(value ?? fallback ?? '').trim();
}

function numString(value, fallback, fieldName) {
  const finalValue = value ?? fallback;
  try {
    D(finalValue);
  } catch {
    throw new Error(`Invalid decimal for ${fieldName}: ${finalValue}`);
  }
  return String(finalValue);
}

function intValue(value, fallback, fieldName) {
  const finalValue = value ?? fallback;
  const num = Number(finalValue);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`Invalid positive integer for ${fieldName}: ${finalValue}`);
  }
  return num;
}

function loadConfig(argv = process.argv.slice(2)) {
  const symbol = String(process.env.SYMBOL || 'USDCUSDT').trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) {
    throw new Error(`Invalid SYMBOL: ${symbol}`);
  }

  const buyThreshold = numString(process.env.BUY_THRESHOLD, '0.9998', 'BUY_THRESHOLD');
  const sellThreshold = numString(process.env.SELL_THRESHOLD, '1.0004', 'SELL_THRESHOLD');

  if (!D(buyThreshold).lt(D(sellThreshold))) {
    throw new Error('BUY_THRESHOLD must be lower than SELL_THRESHOLD');
  }

  const inventoryMode = stringValue(process.env.INVENTORY_MODE, 'wallet').toLowerCase();
  if (!['wallet', 'manual', 'auto'].includes(inventoryMode)) {
    throw new Error(`Invalid INVENTORY_MODE: ${inventoryMode}`);
  }

  return {
    apiKey: required('BYBIT_API_KEY'),
    apiSecret: required('BYBIT_API_SECRET'),
    testnet: boolValue(process.env.BYBIT_TESTNET, false),
    symbol,
    buyThreshold,
    sellThreshold,
    inventoryMode,
    initialUsdt: numString(process.env.INITIAL_USDT, '100', 'INITIAL_USDT'),
    initialUsdc: numString(process.env.INITIAL_USDC, '100', 'INITIAL_USDC'),
    stateFile: path.resolve(process.cwd(), process.env.STATE_FILE || './data/state.json'),
    orderLinkPrefix: String(process.env.ORDER_LINK_PREFIX || 'usdcusdt-grid').trim(),
    printIntervalMs: intValue(process.env.PRINT_INTERVAL_MS, 5000, 'PRINT_INTERVAL_MS'),
    snapshotHeartbeatMs: intValue(process.env.SNAPSHOT_HEARTBEAT_MS, 60000, 'SNAPSHOT_HEARTBEAT_MS'),
    reconcileIntervalMs: intValue(process.env.RECONCILE_INTERVAL_MS, 15000, 'RECONCILE_INTERVAL_MS'),
    walletRefreshIntervalMs: intValue(process.env.WALLET_REFRESH_INTERVAL_MS, 15000, 'WALLET_REFRESH_INTERVAL_MS'),
    restFallbackTickerMs: intValue(process.env.REST_FALLBACK_TICKER_MS, 30000, 'REST_FALLBACK_TICKER_MS'),
    pendingOrderTtlMs: intValue(process.env.PENDING_ORDER_TTL_MS, 15000, 'PENDING_ORDER_TTL_MS'),
    recvWindow: intValue(process.env.RECV_WINDOW, 5000, 'RECV_WINDOW'),
    minOrderAmtOverride: process.env.MIN_ORDER_AMT_OVERRIDE
      ? numString(process.env.MIN_ORDER_AMT_OVERRIDE, null, 'MIN_ORDER_AMT_OVERRIDE')
      : '',
    probeWalletBalance: argv.includes('--probe-wallet') || boolValue(process.env.PROBE_WALLET_BALANCE, false),
  };
}

module.exports = { loadConfig };
