# Bybit 雙邊套利機器人

[English](./README.md) | [简体中文](./readme.zh-CN.md)

一個用於 Bybit 現貨交易對的雙邊掛單機器人。策略基於帳戶可用餘額，在買賣兩側按固定閾值持續掛單。

機器人優先透過 WebSocket 取得行情、訂單與成交事件。REST 僅用於啟動快照、週期對帳與低頻回退。

## 功能特色

- 雙邊同時掛單
  - 有可用 `USDT`，或其他交易對計價貨幣時，在 `BUY_THRESHOLD` 掛買單
  - 有可用 `USDC`，或其他交易對基礎貨幣時，在 `SELL_THRESHOLD` 掛賣單
- 成交後基於新增庫存繼續補單
- WebSocket 優先
  - 公共行情：`tickers.USDCUSDT`，或其他交易對
  - 私有串流：`order`、`execution`
- REST 低頻處理
  - 啟動快照
  - 週期對帳
  - ticker 回退
- 預設使用真實錢包餘額作為庫存來源
- 支援手動庫存模式

## 設定

複製 `.env.example` 為 `.env`：

```env
BYBIT_API_KEY=你的key
BYBIT_API_SECRET=你的secret
BYBIT_TESTNET=false

SYMBOL=USDCUSDT
BUY_THRESHOLD=0.9997
SELL_THRESHOLD=1.0003

# 預設直接使用錢包餘額
INVENTORY_MODE=wallet

# 僅在 manual 模式下使用
INITIAL_USDT=100
INITIAL_USDC=100

# 如果需要手動覆蓋最小訂單金額，可啟用
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

## 設定項說明

### 交易參數

- `SYMBOL`：交易對，預設 `USDCUSDT`
- `BUY_THRESHOLD`：買單掛單價格
- `SELL_THRESHOLD`：賣單掛單價格

### 庫存模式

- `INVENTORY_MODE=wallet`：使用 Bybit 錢包真實餘額作為庫存來源
- `INVENTORY_MODE=manual`：使用本機手動庫存
- `INITIAL_USDT` / `INITIAL_USDC`：僅在 `manual` 模式下生效

### 下單限制

- `MIN_ORDER_AMT_OVERRIDE`：可選。預設優先讀取 `Get Instruments Info` 返回的 `lotSizeFilter.minOrderAmt` 作為最小下單金額。如需手動覆蓋，可透過該變數指定。

### 執行參數

- `ORDER_LINK_PREFIX`：訂單 `orderLinkId` 前綴
- `PRINT_INTERVAL_MS`：狀態列印週期
- `RECONCILE_INTERVAL_MS`：REST 週期對帳間隔
- `WALLET_REFRESH_INTERVAL_MS`：錢包餘額刷新間隔
- `REST_FALLBACK_TICKER_MS`：ticker 的 REST 回退間隔
- `PENDING_ORDER_TTL_MS`：本機待確認訂單保留時間
- `RECV_WINDOW`：Bybit REST 請求接收視窗
- `STATE_FILE`：本機狀態檔案路徑

## 安裝

```bash
npm install
```

## 錢包餘額權限驗證

```bash
npm run probe:wallet
```

成功時會列印：

- `inventory`：錢包總餘額
- `locked`：被現貨掛單鎖住的餘額

## 啟動

```bash
npm start
```

## WebSocket 與 REST

### WebSocket

優先使用以下訂閱串流：

- 公共行情：`tickers.USDCUSDT`
- 私有訂單串流：`order`
- 私有成交串流：`execution`

### REST

用於以下低頻場景：

- 啟動時初始化快照
- 定時對帳
- WebSocket ticker 不可用時的回退讀取

## 日誌

專案統一使用 [`rklogger`](https://www.npmjs.com/package/rklogger) 輸出日誌。

### 日誌環境變數

```env
PRINT_DEBUG=false
PRINT_STACK_DETAIL=false
CONSOLE_LOCALE=en-GB
CONSOLE_TIMEZONE=Australia/Melbourne
SUPPORT_MILLISECONDS=true
```

### 日誌說明

- `PRINT_DEBUG=true`：輸出 `WS_EVENT`、`TICKER_WS` 等除錯事件
- `PRINT_STACK_DETAIL=true`：錯誤日誌追加 stack
- `CONSOLE_LOCALE` / `CONSOLE_TIMEZONE`：控制時間顯示格式與時區
- `SUPPORT_MILLISECONDS=true`：時間戳顯示毫秒

### 日誌內容

#### Instrument Constraints

啟動時會輸出：

- `tickSize`
- `qtyStep`
- `minOrderAmt`
- 目前庫存模式

#### Snapshot

狀態快照包含：

- `ticker`
- `inventoryTotal`
- `locked`
- `pending`
- `free`
- `openOrders`
- `pendingOrderCount`
- `wsTickerAgeMs`

#### WebSocket Event

WebSocket 開啟、回應、錯誤事件以簡潔 JSON 輸出，欄位包括：

- `wsKey`
- `op`
- `success`
- `retMsg`
- `connId`
- `topic`

## 策略行為範例

設定：

- `BUY_THRESHOLD=0.9998`
- `SELL_THRESHOLD=1.0004`

則：

- 如果目前還有可用 `USDT`，機器人會在 `0.9998` 繼續掛買單
- 如果目前還有可用 `USDC`，機器人會在 `1.0004` 繼續掛賣單
- 若某一邊成交，機器人會根據成交後的最新庫存繼續補新的掛單
- 歷史掛單保持不變，不主動撤單

## Rate Limit

Bybit V5 官方上限範例：

- `POST /v5/order/create`：20/s
- `GET /v5/order/realtime`：50/s
- `GET /v5/account/wallet-balance`：50/s

專案本機 limiter 採用更保守的限制：

- `create`：2/s
- `activeOrders`：2/s
- `walletBalance`：2/s
- `ticker`：2/s
