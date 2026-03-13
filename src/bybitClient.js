const { RestClientV5, WebsocketClient } = require('bybit-api');
const { normalizeError, debug } = require('./logger');
const { RollingRateLimiter } = require('./rateLimiter');

function selectWsError(err) {
  if (!err) return { message: 'Unknown websocket error' };
  if (typeof err === 'string') return { message: err };
  return {
    message: err.message || err.msg || err.retMsg || 'WebSocket error',
    wsKey: err.wsKey,
    code: err.code || err.retCode,
    op: err.op,
    success: err.success,
    connId: err.connId || err.conn_id,
  };
}

function selectWsResponse(payload) {
  if (!payload || typeof payload !== 'object') return { raw: String(payload) };
  return {
    op: payload.op,
    success: payload.success,
    retMsg: payload.ret_msg || payload.retMsg,
    connId: payload.conn_id || payload.connId,
    reqId: payload.req_id || payload.reqId,
    type: payload.type,
    topic: payload.topic,
    wsKey: payload.wsKey,
  };
}

class BybitGateway {
  constructor(config) {
    this.config = config;
    this.rest = new RestClientV5({
      key: config.apiKey,
      secret: config.apiSecret,
      testnet: config.testnet,
      recv_window: config.recvWindow,
      enable_time_sync: true,
    });
    this.restLimiter = new RollingRateLimiter({
      instrument: { max: 2, windowMs: 1000 },
      ticker: { max: 2, windowMs: 1000 },
      activeOrders: { max: 2, windowMs: 1000 },
      create: { max: 2, windowMs: 1000 },
      walletBalance: { max: 2, windowMs: 1000 },
    });
    const silentSdkLogger = {
      trace: () => {},
      info: () => {},
      error: () => {},
      warn: () => {},
      warning: () => {},
      debug: () => {},
      notice: () => {},
      silly: () => {},
    };
    this.ws = new WebsocketClient({
      key: config.apiKey,
      secret: config.apiSecret,
      testnet: config.testnet,
      market: 'v5',
      pongTimeout: 1000,
      pingInterval: 10000,
      reconnectTimeout: 500,
    }, silentSdkLogger);
  }

  async getInstrument(symbol) {
    await this.restLimiter.acquire('instrument');
    try {
      const response = await this.rest.getInstrumentsInfo({
        category: 'spot',
        symbol,
      });
      const item = response?.result?.list?.[0];
      if (!item) throw new Error(`Instrument not found for ${symbol}`);
      return item;
    } catch (err) {
      throw new Error(`getInstrument failed: ${normalizeError(err)}`);
    }
  }

  async getTicker(symbol) {
    await this.restLimiter.acquire('ticker');
    try {
      const response = await this.rest.getTickers({ category: 'spot', symbol });
      const item = response?.result?.list?.[0];
      if (!item) throw new Error(`Ticker not found for ${symbol}`);
      return item;
    } catch (err) {
      throw new Error(`getTicker failed: ${normalizeError(err)}`);
    }
  }

  async getActiveOrders(symbol) {
    await this.restLimiter.acquire('activeOrders');
    try {
      const response = await this.rest.getActiveOrders({
        category: 'spot',
        symbol,
        openOnly: 0,
        limit: 50,
      });
      return response?.result?.list || [];
    } catch (err) {
      throw new Error(`getActiveOrders failed: ${normalizeError(err)}`);
    }
  }

  async getWalletBalances() {
    await this.restLimiter.acquire('walletBalance');
    try {
      const response = await this.rest.getWalletBalance({ accountType: 'UNIFIED' });
      const account = response?.result?.list?.[0];
      const rows = Array.isArray(account?.coin) ? account.coin : [];
      const pickCoin = (coin) => rows.find((row) => String(row.coin || '').toUpperCase() === coin) || {};
      const usdt = pickCoin('USDT');
      const usdc = pickCoin('USDC');
      return {
        raw: response,
        accountType: account?.accountType || 'UNIFIED',
        USDT: {
          walletBalance: String(usdt.walletBalance || usdt.equity || 0),
          locked: String(usdt.locked || 0),
          equity: String(usdt.equity || usdt.walletBalance || 0),
        },
        USDC: {
          walletBalance: String(usdc.walletBalance || usdc.equity || 0),
          locked: String(usdc.locked || 0),
          equity: String(usdc.equity || usdc.walletBalance || 0),
        },
      };
    } catch (err) {
      throw new Error(`getWalletBalance failed: ${normalizeError(err)}`);
    }
  }

  async placeLimitOrder({ symbol, side, qty, price, orderLinkId }) {
    await this.restLimiter.acquire('create');
    try {
      if (typeof this.rest.placeOrder === 'function') {
        return await this.rest.placeOrder({
          category: 'spot',
          symbol,
          side,
          orderType: 'Limit',
          qty,
          price,
          timeInForce: 'GTC',
          orderLinkId,
          isLeverage: 0,
          orderFilter: 'Order',
        });
      }
      return await this.rest.submitOrder({
        category: 'spot',
        symbol,
        side,
        orderType: 'Limit',
        qty,
        price,
        timeInForce: 'GTC',
        orderLinkId,
        isLeverage: 0,
        orderFilter: 'Order',
      });
    } catch (err) {
      throw new Error(`placeOrder failed: ${normalizeError(err)}`);
    }
  }

  async probeWalletBalance() {
    return this.getWalletBalances();
  }

  async connectStreams({ symbol, onTicker, onExecution, onOrder, onOpen, onError, onResponse }) {
    this.ws.on('update', (payload) => {
      const topic = String(payload?.topic || '');
      if (topic === `tickers.${symbol}`) {
        const data = Array.isArray(payload.data) ? payload.data[0] : payload.data;
        if (data) onTicker(data, payload);
        return;
      }
      if (topic === 'execution' || topic === 'execution.spot') {
        const rows = Array.isArray(payload.data) ? payload.data : [];
        onExecution(rows, payload);
        return;
      }
      if (topic === 'order' || topic === 'order.spot') {
        const rows = Array.isArray(payload.data) ? payload.data : [];
        onOrder(rows, payload);
      }
    });

    this.ws.on('open', (event) => {
      if (typeof onOpen === 'function') {
        onOpen({ wsKey: event?.wsKey, type: event?.type, url: event?.wsUrl });
      }
    });
    this.ws.on('response', (payload) => {
      if (typeof onResponse === 'function') onResponse(selectWsResponse(payload));
    });
    this.ws.on('reconnect', ({ wsKey }) => {
      if (typeof onResponse === 'function') onResponse({ type: 'reconnect', wsKey });
    });
    this.ws.on('reconnected', ({ wsKey }) => {
      if (typeof onResponse === 'function') onResponse({ type: 'reconnected', wsKey });
    });

    const forwardErr = (err) => {
      if (typeof onError === 'function') onError(selectWsError(err));
    };
    this.ws.on('exception', forwardErr);
    this.ws.on('error', forwardErr);

    this.ws.subscribeV5(`tickers.${symbol}`, 'spot');
    this.ws.subscribeV5(['execution', 'order'], 'linear');
  }
}

module.exports = {
  BybitGateway,
};
