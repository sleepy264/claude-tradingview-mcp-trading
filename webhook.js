import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { appendFileSync, existsSync, writeFileSync } from "fs";

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  bybit: {
    apiKey:    process.env.BYBIT_API_KEY,
    secretKey: process.env.BYBIT_SECRET_KEY,
    baseUrl:   process.env.BYBIT_BASE_URL || "https://api.bybit.com",
  },
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  paperTrading:  process.env.PAPER_TRADING !== "false",
  tradeMode:     process.env.TRADE_MODE    || "futures",
  tradeSize:     parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  leverage:      parseInt(process.env.LEVERAGE || "100"),
};

const LOG_FILE = "webhook-trades.csv";
const CSV_HEADERS = "Timestamp,Symbol,Action,Price,Size USD,Order ID,Mode,Notes";

function initCsv() {
  if (!existsSync(LOG_FILE)) {
    writeFileSync(LOG_FILE, CSV_HEADERS + "\n");
    console.log(`📄 Trade log: ${LOG_FILE}`);
  }
}

function logTrade(symbol, action, price, sizeUSD, orderId, mode, notes) {
  const ts  = new Date().toISOString();
  const row = [ts, symbol, action.toUpperCase(), price, sizeUSD, orderId, mode, `"${notes}"`].join(",");
  appendFileSync(LOG_FILE, row + "\n");
}

// ─── Bybit helpers ───────────────────────────────────────────────────────────

function sign(timestamp, recvWindow, body) {
  const msg = `${timestamp}${CONFIG.bybit.apiKey}${recvWindow}${body}`;
  return crypto.createHmac("sha256", CONFIG.bybit.secretKey).update(msg).digest("hex");
}

async function setLeverage(symbol) {
  const timestamp  = Date.now().toString();
  const recvWindow = "5000";
  const body       = JSON.stringify({ category: "linear", symbol, buyLeverage: String(CONFIG.leverage), sellLeverage: String(CONFIG.leverage) });
  const sig        = sign(timestamp, recvWindow, body);
  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/position/set-leverage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0 && data.retCode !== 110043) throw new Error(`Set leverage failed: ${data.retMsg}`);
}

async function placeOrder(symbol, action, price, sl, tp1) {
  const side     = action === "buy" ? "Buy" : "Sell";
  const quantity = (CONFIG.tradeSize / price).toFixed(3);

  // Use SFX values if provided, otherwise fall back to percentage-based defaults
  const stopLoss   = sl  ? parseFloat(sl).toFixed(2)  : (action === "buy" ? (price * 0.998).toFixed(2) : (price * 1.002).toFixed(2));
  const takeProfit = tp1 ? parseFloat(tp1).toFixed(2) : (action === "buy" ? (price * 1.004).toFixed(2) : (price * 0.996).toFixed(2));

  const orderBody = CONFIG.tradeMode === "futures"
    ? { category: "linear", symbol, side, orderType: "Market", qty: quantity, positionIdx: 0,
        stopLoss, slTriggerBy: "LastPrice", takeProfit, tpTriggerBy: "LastPrice" }
    : { category: "spot", symbol, side, orderType: "Market", qty: quantity };

  const timestamp  = Date.now().toString();
  const recvWindow = "5000";
  const body       = JSON.stringify(orderBody);
  const sig        = sign(timestamp, recvWindow, body);

  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Order failed: ${data.retMsg}`);
  return data.result;
}

async function fetchCurrentPrice(symbol) {
  const res  = await fetch(`${CONFIG.bybit.baseUrl}/v5/market/tickers?category=linear&symbol=${symbol}`);
  const data = await res.json();
  return parseFloat(data.result?.list?.[0]?.lastPrice || "0");
}

async function setTrailingStop(symbol) {
  const price = await fetchCurrentPrice(symbol);
  if (!price) return;

  const trailingDistance = (price * 0.03).toFixed(2);
  const timestamp  = Date.now().toString();
  const recvWindow = "5000";
  const body       = JSON.stringify({ category: "linear", symbol, trailingStop: trailingDistance, positionIdx: 0 });
  const sig        = sign(timestamp, recvWindow, body);
  await fetch(`${CONFIG.bybit.baseUrl}/v5/position/trading-stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
}

// ─── Webhook endpoint ─────────────────────────────────────────────────────────

app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", mode: CONFIG.paperTrading ? "paper" : "live", leverage: CONFIG.leverage });
});

// TradingView alert endpoint
// Expected payload: { "secret": "...", "action": "buy"|"sell", "symbol": "BTCUSDT", "price": 75000 }
app.post("/webhook", async (req, res) => {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] Webhook received:`, JSON.stringify(req.body));
  try { return await handleWebhook(req, res); }
  catch (err) { console.log("  ❌ Unhandled error:", err.message); return res.status(500).json({ error: err.message }); }
});

async function handleWebhook(req, res) {

  const { secret, action, symbol, price, sl, tp1, tp2, tp3 } = req.body;

  // Validate secret token
  if (CONFIG.webhookSecret && secret !== CONFIG.webhookSecret) {
    console.log("  ❌ Invalid secret — rejected");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Validate required fields
  if (!action) {
    console.log("  ❌ Missing field: action");
    return res.status(400).json({ error: "Missing required field: action (buy or sell)" });
  }

  if (!["buy", "sell"].includes(action.toLowerCase())) {
    console.log("  ❌ Invalid action:", action);
    return res.status(400).json({ error: "action must be 'buy' or 'sell'" });
  }

  const actionLower = action.toLowerCase();
  const sym         = symbol || process.env.SYMBOL || "BTCUSDT";

  // Use price from payload, or fetch live price if not provided
  let priceNum = parseFloat(price);
  if (!priceNum || isNaN(priceNum)) {
    console.log("  ℹ️  No price in payload — fetching live price from Bybit...");
    priceNum = await fetchCurrentPrice(sym);
  }

  console.log(`  Signal: ${actionLower.toUpperCase()} ${sym} @ $${priceNum}`);
  if (sl)  console.log(`  SL: $${sl}`);
  if (tp1) console.log(`  TP1: $${tp1}${tp2 ? ` | TP2: $${tp2}` : ""}${tp3 ? ` | TP3: $${tp3}` : ""}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} | Size: $${CONFIG.tradeSize} | Leverage: ${CONFIG.leverage}x`);

  if (CONFIG.paperTrading) {
    const paperId = `PAPER-${Date.now()}`;
    console.log(`  📋 PAPER TRADE — ${actionLower.toUpperCase()} $${CONFIG.tradeSize} ${sym}`);
    const notes = `SL:${sl||"auto"} TP1:${tp1||"auto"} TP2:${tp2||"-"} TP3:${tp3||"-"}`;
    logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, paperId, "PAPER", notes);
    return res.json({ status: "paper", orderId: paperId, action: actionLower, symbol: sym, price: priceNum, sl: sl||null, tp1: tp1||null, tp2: tp2||null, tp3: tp3||null });
  }

  // Live execution
  try {
    if (CONFIG.tradeMode === "futures") {
      await setLeverage(sym);
      console.log(`  Leverage set to ${CONFIG.leverage}x`);
    }

    const order = await placeOrder(sym, actionLower, priceNum, sl, tp1);
    console.log(`  ✅ ORDER PLACED — ${order.orderId}`);

    if (CONFIG.tradeMode === "futures") {
      await setTrailingStop(sym);
      console.log(`  Trailing stop set (3%)`);
    }

    logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, order.orderId, "LIVE", "OK");
    return res.json({ status: "ok", orderId: order.orderId, action: actionLower, symbol: sym, price: priceNum });

  } catch (err) {
    console.log(`  ❌ ERROR — ${err.message}`);
    logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, "", "ERROR", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

initCsv();
app.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradingView Webhook Bot v2");
  console.log(`  Port     : ${PORT}`);
  console.log(`  Mode     : ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Leverage : ${CONFIG.leverage}x`);
  console.log(`  Trade    : $${CONFIG.tradeSize} per signal`);
  console.log(`  Endpoint : POST /webhook`);
  console.log(`  Payload  : { "secret":"...", "action":"buy|sell", "symbol":"BTCUSDT", "price":75000 }`);
  console.log("═══════════════════════════════════════════════════════════");
});
