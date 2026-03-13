# Bybit 双边套利机器人

一个用于Bybit现货交易对的双边挂单机器人。策略基于账户可用余额，在买卖两侧按固定阈值持续挂单；优先通过 WebSocket 获取行情、订单与成交事件，REST 仅用于启动快照、周期对账与低频回退。

## 功能特性

* 双边同时挂单

  * 有可用 `USDT` (或者其他交易对主货币) 时，在 `BUY_THRESHOLD` 挂买单
  * 有可用 `USDC` (或者其他交易对副货币) 时，在 `SELL_THRESHOLD` 挂卖单
* 成交后基于新增库存继续补单
* WebSocket 优先

  * 公共行情：`tickers.USDCUSDT` (或者其他交易对)
  * 私有流：`order`、`execution`
* REST 低频处理
  * 启动快照
  * 周期对账
  * ticker 回退
* 默认使用真实钱包余额作为库存来源
* 支持手动库存模式

## 配置

复制 `.env.example` 为 `.env`：

```env
BYBIT_API_KEY=你的key
BYBIT_API_SECRET=你的secret
BYBIT_TESTNET=false

SYMBOL=USDCUSDT (或者其他交易对)
BUY_THRESHOLD=0.9997
SELL_THRESHOLD=1.0003

# 默认直接使用钱包余额
INVENTORY_MODE=wallet

# 仅在 manual 模式下使用
INITIAL_USDT=100
INITIAL_USDC=100

# 如果需要手动覆盖最小订单金额，可启用
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

### 配置项说明

#### 交易参数

* `SYMBOL`：交易对，默认 `USDCUSDT`
* `BUY_THRESHOLD`：买单挂单价格
* `SELL_THRESHOLD`：卖单挂单价格

#### 库存模式

* `INVENTORY_MODE=wallet`：使用 Bybit 钱包真实余额作为库存来源
* `INVENTORY_MODE=manual`：使用本地手动库存
* `INITIAL_USDT` / `INITIAL_USDC`：仅在 `manual` 模式下生效

#### 下单约束

* `MIN_ORDER_AMT_OVERRIDE`：可选。默认优先读取 `Get Instruments Info` 返回的 `lotSizeFilter.minOrderAmt` 作为最小下单金额；如需手动覆盖，可通过该变量指定

#### 运行参数

* `ORDER_LINK_PREFIX`：订单 `orderLinkId` 前缀
* `PRINT_INTERVAL_MS`：状态打印周期
* `RECONCILE_INTERVAL_MS`：REST 周期对账间隔
* `WALLET_REFRESH_INTERVAL_MS`：钱包余额刷新间隔
* `REST_FALLBACK_TICKER_MS`：ticker 的 REST 回退间隔
* `PENDING_ORDER_TTL_MS`：本地待确认订单保留时间
* `RECV_WINDOW`：Bybit REST 请求接收窗口
* `STATE_FILE`：本地状态文件路径

## 安装

```bash
npm install
```

## 钱包余额权限验证

```bash
npm run probe:wallet
```

成功时会打印：

* `inventory`：钱包总余额
* `locked`：被现货挂单锁住的余额

## 启动

```bash
npm start
```

## WebSocket 与 REST

### WebSocket

优先使用以下订阅流：

* 公共行情：`tickers.USDCUSDT`
* 私有订单流：`order`
* 私有成交流：`execution`

### REST

用于以下低频场景：

* 启动时初始化快照
* 定时对账
* WebSocket ticker 不可用时的回退读取

## 日志

项目统一使用 [`rklogger`](https://www.npmjs.com/package/rklogger) 输出日志。

### 日志环境变量

```env
PRINT_DEBUG=false
PRINT_STACK_DETAIL=false
CONSOLE_LOCALE=en-GB
CONSOLE_TIMEZONE=Australia/Melbourne
SUPPORT_MILLISECONDS=true
```

### 日志说明

* `PRINT_DEBUG=true`：输出 `WS_EVENT`、`TICKER_WS` 等调试事件
* `PRINT_STACK_DETAIL=true`：错误日志追加 stack
* `CONSOLE_LOCALE` / `CONSOLE_TIMEZONE`：控制时间显示格式与时区
* `SUPPORT_MILLISECONDS=true`：时间戳显示毫秒

### 日志内容

#### Instrument Constraints

启动时会输出：

* `tickSize`
* `qtyStep`
* `minOrderAmt`
* 当前库存模式

#### Snapshot

状态快照包含：

* `ticker`
* `inventoryTotal`
* `locked`
* `pending`
* `free`
* `openOrders`
* `pendingOrderCount`
* `wsTickerAgeMs`

#### WebSocket Event

WebSocket 打开、响应、错误事件以简洁 JSON 输出，字段包括：

* `wsKey`
* `op`
* `success`
* `retMsg`
* `connId`
* `topic`

## 策略行为示例

设定：

* `BUY_THRESHOLD=0.9998`
* `SELL_THRESHOLD=1.0004`

则：

* 如果当前还有可用 `USDT`，机器人会在 `0.9998` 继续挂买单
* 如果当前还有可用 `USDC`，机器人会在 `1.0004` 继续挂卖单
* 若某一边成交，机器人会根据成交后的最新库存继续补新的挂单
* 历史挂单保持不变，不主动撤单

## Rate Limit

Bybit V5 官方上限示例：

* `POST /v5/order/create`：20/s
* `GET /v5/order/realtime`：50/s
* `GET /v5/account/wallet-balance`：50/s

项目本地 limiter 采用更保守的限制：

* `create`：2/s
* `activeOrders`：2/s
* `walletBalance`：2/s
* `ticker`：2/s