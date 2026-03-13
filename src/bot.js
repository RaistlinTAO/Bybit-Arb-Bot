const { loadState, saveState } = require('./state');
const { info, warn, error, debug, formatOrderShort } = require('./logger');
const {
  D,
  clampNonNegative,
  floorToStep,
  formatDecimal,
  now,
} = require('./utils');

class DualOrderBot {
  constructor({ config, gateway }) {
    this.config = config;
    this.gateway = gateway;
    this.state = loadState(config);
    this.instrument = null;
    this.tickSize = '0.0001';
    this.qtyStep = '0.000001';
    this.minOrderAmt = '1';

    this.latestTicker = null;
    this.lastTickerAt = 0;
    this.lastPrintAt = 0;
    this.lastReconcileAt = 0;
    this.lastSnapshotSignature = '';
    this.lastSnapshotHeartbeatAt = 0;
    this.reconcileInFlight = false;
    this.pendingReconcile = false;

    this.openOrders = new Map();
    this.pendingOrders = new Map();
    this.walletInventory = {
      total: { USDT: D(0), USDC: D(0) },
      locked: { USDT: D(0), USDC: D(0) },
      source: 'manual',
      refreshedAt: 0,
    };
  }

  async start() {
    await this.bootstrap();
    await this.gateway.connectStreams({
      symbol: this.config.symbol,
      onTicker: (ticker) => this.handleTicker(ticker),
      onExecution: (rows) => this.handleExecutionRows(rows),
      onOrder: (rows) => this.handleOrderRows(rows),
      onOpen: (payload) => info('WS_OPEN', payload),
      onError: (err) => error('WS_ERROR', err),
      onResponse: (payload) => debug('WS_EVENT', payload),
    });

    setInterval(() => {
      this.reconcileAccountState('timer')
        .then(() => this.tryPlaceBothSides('periodic-reconcile'))
        .catch((err) => error('RECONCILE_FAIL', { message: err.message }));
    }, this.config.reconcileIntervalMs).unref();

    setInterval(() => {
      this.refreshWalletInventory('timer')
        .catch((err) => warn('WALLET_REFRESH_FAIL', { message: err.message }));
    }, this.config.walletRefreshIntervalMs).unref();

    setInterval(() => {
      this.ensureFreshTicker().catch((err) => error('TICKER_FALLBACK_FAIL', { message: err.message }));
    }, this.config.restFallbackTickerMs).unref();

    setInterval(() => {
      this.printSnapshot('timer');
    }, this.config.printIntervalMs).unref();

    info('BOT_START', {
      symbol: this.config.symbol,
      buy: this.config.buyThreshold,
      sell: this.config.sellThreshold,
      mode: this.config.inventoryMode,
      inventory: this.snapshotInventory(),
    });
  }

  async bootstrap() {
    this.instrument = await this.gateway.getInstrument(this.config.symbol);
    this.tickSize = this.instrument?.priceFilter?.tickSize || '0.0001';
    this.qtyStep = this.instrument?.lotSizeFilter?.qtyStep
      || this.instrument?.lotSizeFilter?.basePrecision
      || '0.000001';
    this.minOrderAmt = this.config.minOrderAmtOverride
      || this.instrument?.lotSizeFilter?.minOrderAmt
      || this.instrument?.lotSizeFilter?.minNotionalValue
      || '1';

    if (this.config.probeWalletBalance || this.config.inventoryMode !== 'manual') {
      try {
        const result = await this.gateway.probeWalletBalance();
        this.setWalletInventoryFromApi(result);
        info('WALLET_PROBE_OK', {
          accountType: result.accountType,
          inventory: this.snapshotInventory(),
          locked: this.snapshotLockedInventory(),
        });
      } catch (err) {
        if (this.config.inventoryMode === 'wallet') throw err;
        warn('WALLET_PROBE_FAIL', { message: err.message, fallback: 'manual' });
      }
    }

    info('INSTRUMENT', {
      symbol: this.config.symbol,
      tickSize: this.tickSize,
      qtyStep: this.qtyStep,
      minOrderAmt: this.minOrderAmt,
      inventoryMode: this.getInventoryModeInUse(),
    });

    await this.ensureFreshTicker(true);
    await this.reconcileAccountState('bootstrap');
    this.printSnapshot('bootstrap');
    await this.tryPlaceBothSides('bootstrap');
  }

  getInventoryModeInUse() {
    return this.walletInventory.source === 'wallet-api' ? 'wallet' : 'manual';
  }

  setWalletInventoryFromApi(result) {
    this.walletInventory = {
      total: {
        USDT: D(result?.USDT?.walletBalance || 0),
        USDC: D(result?.USDC?.walletBalance || 0),
      },
      locked: {
        USDT: D(result?.USDT?.locked || 0),
        USDC: D(result?.USDC?.locked || 0),
      },
      source: 'wallet-api',
      refreshedAt: now(),
    };
  }

  snapshotInventory() {
    const total = this.getInventoryTotals();
    return {
      USDT: formatDecimal(total.USDT, 8),
      USDC: formatDecimal(total.USDC, 8),
    };
  }

  snapshotLockedInventory() {
    const locked = this.getLockedInventory();
    return {
      USDT: formatDecimal(locked.USDT, 8),
      USDC: formatDecimal(locked.USDC, 8),
    };
  }

  getInventoryTotals() {
    if (this.walletInventory.source === 'wallet-api') {
      return this.walletInventory.total;
    }
    return {
      USDT: D(this.state.manualInventory.USDT),
      USDC: D(this.state.manualInventory.USDC),
    };
  }

  getLockedInventory() {
    if (this.walletInventory.source === 'wallet-api') {
      return this.walletInventory.locked;
    }
    const totals = { USDT: D(0), USDC: D(0) };
    for (const order of this.getBotOpenOrders()) {
      const side = String(order.side || '');
      const leavesQty = D(order.leavesQty || order.qty || 0);
      const price = D(order.price || 0);
      if (side === 'Buy') totals.USDT = totals.USDT.plus(leavesQty.mul(price));
      if (side === 'Sell') totals.USDC = totals.USDC.plus(leavesQty);
    }
    return totals;
  }

  getBotOpenOrders() {
    return [...this.openOrders.values()]
      .filter((row) => String(row.orderLinkId || '').startsWith(this.config.orderLinkPrefix));
  }

  getPendingReservations() {
    const cutoff = now() - this.config.pendingOrderTtlMs;
    for (const [key, row] of this.pendingOrders.entries()) {
      if (row.createdAt < cutoff) {
        this.pendingOrders.delete(key);
      }
    }

    const totals = { USDT: D(0), USDC: D(0) };
    for (const row of this.pendingOrders.values()) {
      totals.USDT = totals.USDT.plus(row.reserveUSDT || 0);
      totals.USDC = totals.USDC.plus(row.reserveUSDC || 0);
    }
    return totals;
  }

  getFreeInventory() {
    const total = this.getInventoryTotals();
    const locked = this.getLockedInventory();
    const pending = this.getPendingReservations();

    return {
      USDT: clampNonNegative(total.USDT.minus(locked.USDT).minus(pending.USDT)),
      USDC: clampNonNegative(total.USDC.minus(locked.USDC).minus(pending.USDC)),
      lockedUSDT: locked.USDT,
      lockedUSDC: locked.USDC,
      pendingUSDT: pending.USDT,
      pendingUSDC: pending.USDC,
    };
  }

  makeBuyOrderFromFreeUsdt(freeUsdt) {
    const price = D(this.config.buyThreshold);
    if (freeUsdt.lte(0) || price.lte(0)) return null;
    const qty = floorToStep(freeUsdt.div(price), this.qtyStep);
    const notional = qty.mul(price);
    if (qty.lte(0) || notional.lt(this.minOrderAmt)) return null;
    return {
      side: 'Buy',
      price: formatDecimal(price, this.tickSize),
      qty: formatDecimal(qty, this.qtyStep),
      reserveUSDT: notional,
      reserveUSDC: D(0),
    };
  }

  makeSellOrderFromFreeUsdc(freeUsdc) {
    const price = D(this.config.sellThreshold);
    if (freeUsdc.lte(0) || price.lte(0)) return null;
    const qty = floorToStep(freeUsdc, this.qtyStep);
    const notional = qty.mul(price);
    if (qty.lte(0) || notional.lt(this.minOrderAmt)) return null;
    return {
      side: 'Sell',
      price: formatDecimal(price, this.tickSize),
      qty: formatDecimal(qty, this.qtyStep),
      reserveUSDT: D(0),
      reserveUSDC: qty,
    };
  }

  async tryPlaceBothSides(reason) {
    const free = this.getFreeInventory();
    const buyOrder = this.makeBuyOrderFromFreeUsdt(free.USDT);
    const sellOrder = this.makeSellOrderFromFreeUsdc(free.USDC);

    if (!buyOrder && !sellOrder) {
      info('NO_ORDER', {
        reason,
        freeUSDT: formatDecimal(free.USDT, 8),
        freeUSDC: formatDecimal(free.USDC, 8),
        minOrderAmt: this.minOrderAmt,
      });
      return;
    }

    if (buyOrder) await this.placeIncrementalOrder(buyOrder, reason);
    if (sellOrder) await this.placeIncrementalOrder(sellOrder, reason);
  }

  async placeIncrementalOrder(order, reason) {
    const orderLinkId = `${this.config.orderLinkPrefix}-${order.side.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pendingOrders.set(orderLinkId, {
      createdAt: now(),
      reserveUSDT: D(order.reserveUSDT || 0),
      reserveUSDC: D(order.reserveUSDC || 0),
    });

    info('ORDER_CREATE', {
      reason,
      side: order.side,
      price: order.price,
      qty: order.qty,
      orderLinkId,
    });

    try {
      const response = await this.gateway.placeLimitOrder({
        symbol: this.config.symbol,
        side: order.side,
        qty: order.qty,
        price: order.price,
        orderLinkId,
      });
      const result = response?.result || {};
      info('ORDER_ACCEPTED', {
        orderId: result.orderId,
        orderLinkId: result.orderLinkId || orderLinkId,
        side: order.side,
      });
      await this.reconcileAccountState('post-create');
    } catch (err) {
      this.pendingOrders.delete(orderLinkId);
      throw err;
    }
  }

  async refreshWalletInventory(reason = 'refresh') {
    if (this.config.inventoryMode === 'manual') return;
    try {
      const result = await this.gateway.getWalletBalances();
      this.setWalletInventoryFromApi(result);
      if (reason !== 'timer') {
        info('WALLET_REFRESH', {
          reason,
          inventory: this.snapshotInventory(),
          locked: this.snapshotLockedInventory(),
        });
      }
    } catch (err) {
      if (this.config.inventoryMode === 'wallet') throw err;
      warn('WALLET_REFRESH_FAIL', { reason, message: err.message });
    }
  }

  async reconcileOpenOrders() {
    if (this.reconcileInFlight) {
      this.pendingReconcile = true;
      return;
    }

    this.reconcileInFlight = true;
    try {
      const rows = await this.gateway.getActiveOrders(this.config.symbol);
      const nextMap = new Map();
      for (const row of rows) {
        if (!String(row.orderLinkId || '').startsWith(this.config.orderLinkPrefix)) continue;
        const status = String(row.orderStatus || '');
        if (['New', 'PartiallyFilled', 'Untriggered'].includes(status)) {
          nextMap.set(String(row.orderId), row);
          this.pendingOrders.delete(String(row.orderLinkId || ''));
        }
      }
      this.openOrders = nextMap;
      this.lastReconcileAt = now();
    } finally {
      this.reconcileInFlight = false;
      if (this.pendingReconcile) {
        this.pendingReconcile = false;
        setImmediate(() => {
          this.reconcileAccountState('deferred').catch((err) => error('RECONCILE_DEFERRED_FAIL', { message: err.message }));
        });
      }
    }
  }

  async reconcileAccountState(reason = 'reconcile') {
    await this.reconcileOpenOrders();
    await this.refreshWalletInventory(reason);
  }

  async ensureFreshTicker(force = false) {
    const stale = force || !this.latestTicker || (now() - this.lastTickerAt > this.config.restFallbackTickerMs);
    if (!stale) return;
    const ticker = await this.gateway.getTicker(this.config.symbol);
    this.handleTicker(ticker, true);
  }

  handleTicker(ticker, fromRest = false) {
    this.latestTicker = {
      bid1Price: String(ticker.bid1Price || ''),
      ask1Price: String(ticker.ask1Price || ''),
      lastPrice: String(ticker.lastPrice || ''),
    };
    this.lastTickerAt = now();
    if (fromRest) info('TICKER_REST', this.latestTicker);
    else debug('TICKER_WS', this.latestTicker);
  }

  handleOrderRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const relevant = rows.filter((row) => String(row.symbol || '') === this.config.symbol
      && String(row.orderLinkId || '').startsWith(this.config.orderLinkPrefix));
    if (relevant.length === 0) return;

    info('ORDER_UPDATE', {
      count: relevant.length,
      orders: relevant.map((row) => formatOrderShort(row)),
    });

    this.reconcileAccountState('order-update')
      .then(() => this.tryPlaceBothSides('order-update'))
      .catch((err) => error('ORDER_UPDATE_FAIL', { message: err.message }));
  }

  handleExecutionRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;

    let changed = false;
    for (const row of rows) {
      if (String(row.symbol || '') !== this.config.symbol) continue;
      if (!String(row.orderLinkId || '').startsWith(this.config.orderLinkPrefix)) continue;
      const execId = String(row.execId || `${row.symbol}-${row.seq}-${row.orderId}-${row.execTime}`);
      if (this.state.processedExecIds.includes(execId)) continue;
      this.applyExecution(row);
      this.state.processedExecIds.push(execId);
      changed = true;
    }

    if (!changed) return;
    this.state.processedExecIds = this.state.processedExecIds.slice(-5000);
    saveState(this.config.stateFile, this.state);

    this.reconcileAccountState('execution')
      .then(() => this.tryPlaceBothSides('execution'))
      .then(() => this.printSnapshot('execution'))
      .catch((err) => error('EXECUTION_FOLLOWUP_FAIL', { message: err.message }));
  }

  applyExecution(row) {
    const side = String(row.side || '');
    const execQty = D(row.execQty || 0);
    const execValue = D(row.execValue || 0);
    const execFee = D(row.execFee || 0);
    const feeCurrency = String(row.feeCurrency || '').toUpperCase();

    if (this.walletInventory.source === 'wallet-api') {
      let totalUsdt = D(this.walletInventory.total.USDT);
      let totalUsdc = D(this.walletInventory.total.USDC);

      if (side === 'Buy') {
        totalUsdt = totalUsdt.minus(execValue);
        totalUsdc = totalUsdc.plus(execQty);
      } else if (side === 'Sell') {
        totalUsdt = totalUsdt.plus(execValue);
        totalUsdc = totalUsdc.minus(execQty);
      } else {
        return;
      }
      if (feeCurrency === 'USDT') totalUsdt = totalUsdt.minus(execFee);
      if (feeCurrency === 'USDC') totalUsdc = totalUsdc.minus(execFee);

      this.walletInventory.total.USDT = clampNonNegative(totalUsdt);
      this.walletInventory.total.USDC = clampNonNegative(totalUsdc);
      this.walletInventory.refreshedAt = now();
    }

    let manualUsdt = D(this.state.manualInventory.USDT);
    let manualUsdc = D(this.state.manualInventory.USDC);

    if (side === 'Buy') {
      manualUsdt = manualUsdt.minus(execValue);
      manualUsdc = manualUsdc.plus(execQty);
    } else if (side === 'Sell') {
      manualUsdt = manualUsdt.plus(execValue);
      manualUsdc = manualUsdc.minus(execQty);
    } else {
      warn('EXECUTION_SIDE_UNKNOWN', { side });
      return;
    }

    if (feeCurrency === 'USDT') manualUsdt = manualUsdt.minus(execFee);
    if (feeCurrency === 'USDC') manualUsdc = manualUsdc.minus(execFee);

    this.state.manualInventory.USDT = formatDecimal(clampNonNegative(manualUsdt), 16);
    this.state.manualInventory.USDC = formatDecimal(clampNonNegative(manualUsdc), 16);

    info('EXECUTION', {
      side,
      execQty: row.execQty,
      execPrice: row.execPrice,
      execValue: row.execValue,
      execFee: row.execFee,
      feeCurrency: row.feeCurrency,
      inventory: this.snapshotInventory(),
    });
  }

  buildSnapshotSummary(reason) {
    const free = this.getFreeInventory();
    const inventory = this.snapshotInventory();
    const openOrders = this.getBotOpenOrders();
    const buyOrders = openOrders.filter((row) => row.side === 'Buy');
    const sellOrders = openOrders.filter((row) => row.side === 'Sell');
    const stateSignature = JSON.stringify({
      reason: reason === 'timer' ? 'timer' : reason,
      mode: this.getInventoryModeInUse(),
      totalUSDT: inventory.USDT,
      totalUSDC: inventory.USDC,
      freeUSDT: formatDecimal(free.USDT, 8),
      freeUSDC: formatDecimal(free.USDC, 8),
      lockedUSDT: formatDecimal(free.lockedUSDT, 8),
      lockedUSDC: formatDecimal(free.lockedUSDC, 8),
      pendingUSDT: formatDecimal(free.pendingUSDT, 8),
      pendingUSDC: formatDecimal(free.pendingUSDC, 8),
      buys: buyOrders.map((row) => [row.price, row.leavesQty || row.qty, row.orderStatus]),
      sells: sellOrders.map((row) => [row.price, row.leavesQty || row.qty, row.orderStatus]),
      pendingOrders: this.pendingOrders.size,
    });
    const summary = {
      reason,
      last: this.latestTicker?.lastPrice || '',
      bid: this.latestTicker?.bid1Price || '',
      ask: this.latestTicker?.ask1Price || '',
      mode: this.getInventoryModeInUse(),
      totalUSDT: inventory.USDT,
      totalUSDC: inventory.USDC,
      freeUSDT: formatDecimal(free.USDT, 8),
      freeUSDC: formatDecimal(free.USDC, 8),
      lockedUSDT: formatDecimal(free.lockedUSDT, 8),
      lockedUSDC: formatDecimal(free.lockedUSDC, 8),
      pendingUSDT: formatDecimal(free.pendingUSDT, 8),
      pendingUSDC: formatDecimal(free.pendingUSDC, 8),
      buys: buyOrders.length,
      sells: sellOrders.length,
      buyBook: buyOrders.map((row) => formatOrderShort(row)),
      sellBook: sellOrders.map((row) => formatOrderShort(row)),
      pendingOrders: this.pendingOrders.size,
      wsAgeMs: this.latestTicker ? now() - this.lastTickerAt : null,
    };
    return { summary, stateSignature };
  }

  printSnapshot(reason) {
    const currentTime = now();
    if (reason === 'timer' && currentTime - this.lastPrintAt < this.config.printIntervalMs - 50) {
      return;
    }
    this.lastPrintAt = currentTime;

    const { summary, stateSignature } = this.buildSnapshotSummary(reason);
    const forceHeartbeat = currentTime - this.lastSnapshotHeartbeatAt >= this.config.snapshotHeartbeatMs;
    if (reason === 'timer' && !forceHeartbeat && stateSignature === this.lastSnapshotSignature) {
      return;
    }

    this.lastSnapshotSignature = stateSignature;
    this.lastSnapshotHeartbeatAt = currentTime;
    info('SNAPSHOT', summary);
  }
}

module.exports = {
  DualOrderBot,
};
