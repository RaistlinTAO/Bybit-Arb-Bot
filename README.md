# Bybit Two-Sided Arbitrage Bot

[简体中文](./readme.zh-CN.md)

A two-sided limit-order bot for Bybit spot trading pairs. The strategy continuously places orders on both the buy and sell sides at fixed thresholds based on available account balance.

The bot prioritizes WebSocket for market data, order events, and execution events. REST is used only for startup snapshots, periodic reconciliation, and low-frequency fallbacks.

## Features

- Simultaneous two-sided order placement
  - When available `USDT`, or another quote currency, exists, the bot places buy orders at `BUY_THRESHOLD`
  - When available `USDC`, or another base currency, exists, the bot places sell orders at `SELL_THRESHOLD`
- Replenishes orders after fills based on newly added inventory
- WebSocket-first design
  - Public market data: `tickers.USDCUSDT`, or another trading pair
  - Private streams: `order`, `execution`
- Low-frequency REST handling
  - Startup snapshots
  - Periodic reconciliation
  - Ticker fallback
- Uses real wallet balances as the default inventory source
- Supports manual inventory mode

## Configuration

Copy `.env.example` to `.env`:

```env
BYBIT_API_KEY=your_key
BYBIT_API_SECRET=your_secret
BYBIT_TESTNET=false

SYMBOL=USDCUSDT
BUY_THRESHOLD=0.9997
SELL_THRESHOLD=1.0003

# Uses wallet balance directly by default
INVENTORY_MODE=wallet

# Only used in manual mode
INITIAL_USDT=100
INITIAL_USDC=100

# Enable this if you need to manually override the minimum order amount
# MIN_ORDER_AMT_OVERRIDE=1

ORDER_LINK_PREFIX=usdcusdt-grid
PRINT_INTERVAL_MS=5000
RECONCILE_INTERVAL_MS=15000
WALLET_REFRESH_INTERVAL_MS=15000
REST_FALLBACK_TICKER_MS=30000
PENDING_ORDER_TTL_MS=15000
RECV_WINDOW=5000
STATE_FILE=./data/state.json
```

## Configuration Options

### Trading Parameters

- `SYMBOL`: Trading pair. Default: `USDCUSDT`
- `BUY_THRESHOLD`: Buy order limit price
- `SELL_THRESHOLD`: Sell order limit price

### Inventory Mode

- `INVENTORY_MODE=wallet`: Uses real Bybit wallet balances as the inventory source
- `INVENTORY_MODE=manual`: Uses local manual inventory
- `INITIAL_USDT` / `INITIAL_USDC`: Only effective in `manual` mode

### Order Constraints

- `MIN_ORDER_AMT_OVERRIDE`: Optional. By default, the bot prioritizes `lotSizeFilter.minOrderAmt` returned by `Get Instruments Info` as the minimum order amount. If a manual override is needed, this variable can be used.

### Runtime Parameters

- `ORDER_LINK_PREFIX`: Prefix for `orderLinkId`
- `PRINT_INTERVAL_MS`: Status print interval
- `RECONCILE_INTERVAL_MS`: REST periodic reconciliation interval
- `WALLET_REFRESH_INTERVAL_MS`: Wallet balance refresh interval
- `REST_FALLBACK_TICKER_MS`: REST fallback interval for ticker data
- `PENDING_ORDER_TTL_MS`: Retention time for locally pending orders
- `RECV_WINDOW`: Bybit REST request receive window
- `STATE_FILE`: Local state file path

## Installation

```bash
npm install
```

## Wallet Balance Permission Check

```bash
npm run probe:wallet
```

On success, it prints:

- `inventory`: Total wallet balance
- `locked`: Balance locked by spot open orders

## Start

```bash
npm start
```

## WebSocket and REST

### WebSocket

The following streams are prioritized:

- Public market data: `tickers.USDCUSDT`
- Private order stream: `order`
- Private execution stream: `execution`

### REST

Used for the following low-frequency scenarios:

- Initial snapshot at startup
- Scheduled reconciliation
- Fallback reads when WebSocket ticker data is unavailable

## Logging

The project uses [`rklogger`](https://www.npmjs.com/package/rklogger) for unified logging output.

### Logging Environment Variables

```env
PRINT_DEBUG=false
PRINT_STACK_DETAIL=false
CONSOLE_LOCALE=en-GB
CONSOLE_TIMEZONE=Australia/Melbourne
SUPPORT_MILLISECONDS=true
```

### Logging Options

- `PRINT_DEBUG=true`: Outputs debug events such as `WS_EVENT` and `TICKER_WS`
- `PRINT_STACK_DETAIL=true`: Appends stack traces to error logs
- `CONSOLE_LOCALE` / `CONSOLE_TIMEZONE`: Controls timestamp display locale and timezone
- `SUPPORT_MILLISECONDS=true`: Displays milliseconds in timestamps

### Log Contents

#### Instrument Constraints

Printed at startup:

- `tickSize`
- `qtyStep`
- `minOrderAmt`
- Current inventory mode

#### Snapshot

Status snapshots include:

- `ticker`
- `inventoryTotal`
- `locked`
- `pending`
- `free`
- `openOrders`
- `pendingOrderCount`
- `wsTickerAgeMs`

#### WebSocket Event

WebSocket open, response, and error events are logged as concise JSON, including fields such as:

- `wsKey`
- `op`
- `success`
- `retMsg`
- `connId`
- `topic`

## Strategy Behavior Example

Settings:

- `BUY_THRESHOLD=0.9998`
- `SELL_THRESHOLD=1.0004`

Behavior:

- If available `USDT` remains, the bot continues placing buy orders at `0.9998`
- If available `USDC` remains, the bot continues placing sell orders at `1.0004`
- If one side is filled, the bot continues placing new orders based on the latest inventory after the fill
- Existing historical open orders remain unchanged and are not actively cancelled

## Rate Limit

Example official Bybit V5 limits:

- `POST /v5/order/create`: 20/s
- `GET /v5/order/realtime`: 50/s
- `GET /v5/account/wallet-balance`: 50/s

The project’s local limiter uses more conservative limits:

- `create`: 2/s
- `activeOrders`: 2/s
- `walletBalance`: 2/s
- `ticker`: 2/s
