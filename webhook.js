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
  webhookSecret:    process.env.WEBHOOK_SECRET     || "",
  paperTrading:     process.env.PAPER_TRADING      !== "false",
  tradeMode:        process.env.TRADE_MODE         || "futures",
  tradeSize:        parseFloat(process.env.MAX_TRADE_SIZE_USD  || "100"),
  leverage:         parseInt(process.env.LEVERAGE              || "100"),
  stopLossPct:      parseFloat(process.env.STOP_LOSS_PCT       || "0.002"),
  takeProfitPct:    parseFloat(process.env.TAKE_PROFIT_PCT     || "0.004"),
  trailingStopPct:        parseFloat(process.env.TRAILING_STOP_PCT        || "0.03"),
  trailingActivationPct:  parseFloat(process.env.TRAILING_ACTIVATION_PCT  || "0.003"),
  maxDailyLossPerSymbol:  parseFloat(process.env.MAX_DAILY_LOSS_PER_SYMBOL || "0"),  // 0 = disabled
  maxDailyLossTotal:      parseFloat(process.env.MAX_DAILY_LOSS_TOTAL      || "0"),  // 0 = disabled
  riskPerTradeUSD:        parseFloat(process.env.RISK_PER_TRADE_USD        || "0"),  // 0 = fixed size
  // ATR-based SL: SL is placed at ATR_MULTIPLIER × ATR(ATR_PERIOD) from entry
  // If ATR fetch fails, falls back to STOP_LOSS_PCT
  atrMultiplier:    parseFloat(process.env.ATR_MULTIPLIER  || "1.5"),
  atrPeriod:        parseInt(process.env.ATR_PERIOD        || "14"),
  candleInterval:   process.env.CANDLE_INTERVAL            || "15",  // minutes: 1,3,5,15,30,60,120,240,D
  // Volatility filter: skip trade if ATR-derived SL % exceeds this threshold (0 = disabled)
  maxSlPct:         parseFloat(process.env.MAX_SL_PCT      || "0"),
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

// ─── Telegram Notifications ──────────────────────────────────────────────────

async function sendTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
  }).catch((e) => console.log("Telegram error:", e.message));
}

// ─── Bybit helpers ───────────────────────────────────────────────────────────

function sign(timestamp, recvWindow, body) {
  const msg = `${timestamp}${CONFIG.bybit.apiKey}${recvWindow}${body}`;
  return crypto.createHmac("sha256", CONFIG.bybit.secretKey).update(msg).digest("hex");
}

async function setLeverage(symbol, lev) {
  const timestamp  = (Date.now() - 1500).toString();
  const recvWindow = "10000";
  const body       = JSON.stringify({ category: "linear", symbol, buyLeverage: String(lev), sellLeverage: String(lev) });
  const sig        = sign(timestamp, recvWindow, body);
  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/position/set-leverage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0 && data.retCode !== 110043) throw new Error(`Set leverage failed: ${data.retMsg}`);
}

async function getInstrumentLotSize(symbol) {
  const res  = await fetch(`${CONFIG.bybit.baseUrl}/v5/market/instruments-info?category=linear&symbol=${symbol}`);
  const data = await res.json();
  const lot  = data.result?.list?.[0]?.lotSizeFilter;
  return { minQty: parseFloat(lot?.minOrderQty || "0.001"), qtyStep: parseFloat(lot?.qtyStep || "0.001") };
}

// Fetch candles from Bybit and compute simple ATR(period).
// Bybit kline returns rows newest-first: [time, open, high, low, close, volume, turnover]
// If TradingView already sends "atr" in the payload, this function is skipped entirely.
async function fetchATR(symbol) {
  const limit = CONFIG.atrPeriod + 1; // need one extra candle for the first prev-close
  const res   = await fetch(
    `${CONFIG.bybit.baseUrl}/v5/market/kline?category=linear&symbol=${symbol}&interval=${CONFIG.candleInterval}&limit=${limit}`
  );
  const data    = await res.json();
  const candles = data.result?.list;
  if (!candles || candles.length < CONFIG.atrPeriod + 1)
    throw new Error(`ATR: só ${candles?.length ?? 0} velas disponíveis (precisa de ${CONFIG.atrPeriod + 1})`);

  let trSum = 0;
  for (let i = 0; i < CONFIG.atrPeriod; i++) {
    const high      = parseFloat(candles[i][2]);
    const low       = parseFloat(candles[i][3]);
    const prevClose = parseFloat(candles[i + 1][4]);  // i+1 = older candle
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  return trSum / CONFIG.atrPeriod;
}

// Risk-based sizing: tradeSize so that SL (stopLossPct) = exactly riskUSD
// Formula: loss = tradeSize × leverage × stopLossPct = riskUSD
//          tradeSize = riskUSD / (leverage × stopLossPct), capped at maxTradeSize
function calcRiskBasedTradeSize(riskUSD, leverage, stopLossPct, maxTradeSize) {
  const sized  = riskUSD / (leverage * stopLossPct);
  return parseFloat(Math.min(sized, maxTradeSize).toFixed(2));
}

function calcQty(sizeUSD, leverage, price, minQty, qtyStep) {
  const raw      = (sizeUSD * leverage) / price;
  const steps    = Math.floor(raw / qtyStep);
  const qty      = Math.max(steps * qtyStep, minQty);
  const decimals = (qtyStep.toString().split(".")[1] || "").length;
  return qty.toFixed(decimals);
}

// atrValue: if provided (from payload or pre-fetched), skips the Bybit candle fetch.
async function placeOrder(symbol, action, price, lev, atrValue = null) {
  const side = action === "buy" ? "Buy" : "Sell";

  // ── ATR-based SL ─────────────────────────────────────────────────────────
  let atr = atrValue;
  if (!atr) {
    try {
      atr = await fetchATR(symbol);
    } catch (e) {
      console.log(`  ⚠️  ATR fetch falhou (${e.message}) — a usar SL fixo ${CONFIG.stopLossPct * 100}%`);
    }
  }

  let slPct, slDistance;
  if (atr) {
    slDistance = atr * CONFIG.atrMultiplier;
    slPct      = slDistance / price;
    console.log(`  ATR(${CONFIG.atrPeriod},${CONFIG.candleInterval}m)=$${atr.toFixed(4)} | SL=${CONFIG.atrMultiplier}×ATR=$${slDistance.toFixed(4)} (${(slPct * 100).toFixed(3)}%)`);
  } else {
    slPct      = CONFIG.stopLossPct;
    slDistance = price * slPct;
    console.log(`  SL fixo: ${(slPct * 100).toFixed(2)}%`);
  }

  // ── Position sizing ───────────────────────────────────────────────────────
  const tradeSize = CONFIG.riskPerTradeUSD > 0
    ? calcRiskBasedTradeSize(CONFIG.riskPerTradeUSD, lev, slPct, CONFIG.tradeSize)
    : CONFIG.tradeSize;
  const tradeSizeMode = CONFIG.riskPerTradeUSD > 0
    ? `risk-based ($${CONFIG.riskPerTradeUSD} risco → $${tradeSize} margem, perda máx $${(CONFIG.riskPerTradeUSD).toFixed(2)})`
    : `fixo ($${tradeSize})`;

  const { minQty, qtyStep } = await getInstrumentLotSize(symbol);
  const quantity = calcQty(tradeSize, lev, price, minQty, qtyStep);
  console.log(`  Size: ${tradeSizeMode} | Qty: ${quantity} (${lev}x ÷ $${price.toFixed(2)}, min=${minQty}, step=${qtyStep})`);

  const stopLoss = action === "buy"
    ? (price - slDistance).toFixed(2)
    : (price + slDistance).toFixed(2);
  console.log(`  SL: $${stopLoss}`);
  // TP is managed by TradingView webhooks (tp/tp2) — no native Bybit TP set
  // to avoid conflict with the half-close + break-even logic

  const orderBody = CONFIG.tradeMode === "futures"
    ? { category: "linear", symbol, side, orderType: "Market", qty: quantity, positionIdx: 0,
        stopLoss, slTriggerBy: "LastPrice" }
    : { category: "spot", symbol, side, orderType: "Market", qty: quantity };

  const timestamp  = (Date.now() - 1500).toString();
  const recvWindow = "10000";
  const body       = JSON.stringify(orderBody);
  const sig        = sign(timestamp, recvWindow, body);

  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Order failed: ${data.retMsg}`);
  // Return order result enriched with SL + sizing info so the caller can use it in logs/Telegram
  return { ...data.result, slPrice: stopLoss, slPct, slDistance, atrUsed: atr, tradeSize };
}

async function fetchCurrentPrice(symbol) {
  const res  = await fetch(`${CONFIG.bybit.baseUrl}/v5/market/tickers?category=linear&symbol=${symbol}`);
  const data = await res.json();
  return parseFloat(data.result?.list?.[0]?.lastPrice || "0");
}

async function getOpenPosition(symbol) {
  const timestamp  = (Date.now() - 1500).toString();
  const recvWindow = "10000";
  const params     = `category=linear&symbol=${symbol}`;
  const sig        = sign(timestamp, recvWindow, params);
  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/position/list?${params}`, {
    headers: { "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
  });
  const data = await res.json();
  const position = data.result?.list?.[0];
  if (!position) return null;
  const size = parseFloat(position.size);
  return size > 0 ? { side: position.side, size, stopLoss: parseFloat(position.stopLoss || "0") } : null;
}

async function closePosition(symbol, position) {
  const closeSide  = position.side === "Buy" ? "Sell" : "Buy";
  const timestamp  = (Date.now() - 1500).toString();
  const recvWindow = "10000";
  const body       = JSON.stringify({ category: "linear", symbol, side: closeSide, orderType: "Market", qty: String(position.size), positionIdx: 0, reduceOnly: true });
  const sig        = sign(timestamp, recvWindow, body);
  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Close position failed: ${data.retMsg}`);
  return data.result;
}

async function closeHalfPosition(symbol, position) {
  const { qtyStep } = await getInstrumentLotSize(symbol);
  const decimals    = (qtyStep.toString().split(".")[1] || "").length;
  // Round half down to nearest qtyStep to avoid over-reducing
  const halfRaw  = position.size / 2;
  const halfQty  = (Math.floor(halfRaw / qtyStep) * qtyStep).toFixed(decimals);
  if (parseFloat(halfQty) <= 0) throw new Error(`Half qty (${halfQty}) is zero — position too small to split`);

  const closeSide  = position.side === "Buy" ? "Sell" : "Buy";
  const timestamp  = (Date.now() - 1500).toString();
  const recvWindow = "10000";
  const body       = JSON.stringify({ category: "linear", symbol, side: closeSide, orderType: "Market", qty: halfQty, positionIdx: 0, reduceOnly: true });
  const sig        = sign(timestamp, recvWindow, body);
  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Close half position failed: ${data.retMsg}`);
  return { ...data.result, closedQty: halfQty, remainingQty: (position.size - parseFloat(halfQty)).toFixed(decimals) };
}

async function setBreakEvenStop(symbol, entryPrice) {
  const slPrice    = parseFloat(entryPrice).toFixed(2);
  const timestamp  = Date.now().toString();
  const recvWindow = "5000";
  const body       = JSON.stringify({ category: "linear", symbol, stopLoss: slPrice, slTriggerBy: "LastPrice", positionIdx: 0 });
  const sig        = sign(timestamp, recvWindow, body);
  const res  = await fetch(`${CONFIG.bybit.baseUrl}/v5/position/trading-stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Set break-even SL failed: ${data.retMsg}`);
}

// Returns today's total realised PnL (negative = loss).
// Pass symbol to get per-pair PnL; omit for all symbols combined.
async function getDailyClosedPnl(symbol = null) {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const startTime  = todayMidnight.getTime().toString();
  const timestamp  = (Date.now() - 1500).toString();
  const recvWindow = "10000";
  const params     = `category=linear${symbol ? `&symbol=${symbol}` : ""}&startTime=${startTime}&limit=200`;
  const sig        = sign(timestamp, recvWindow, params);
  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/position/closed-pnl?${params}`, {
    headers: { "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
  });
  const data = await res.json();
  const list = data.result?.list || [];
  return list.reduce((sum, item) => sum + parseFloat(item.closedPnl || 0), 0);
}

// atr: if provided, trailing distance = atr × ATR_MULTIPLIER (same buffer as the SL).
// Fallback: entryPrice × TRAILING_STOP_PCT (legacy fixed %).
async function setTrailingStop(symbol, action, entryPrice, atr = null) {
  const trailingDistance = atr
    ? (atr * CONFIG.atrMultiplier).toFixed(2)
    : (entryPrice * CONFIG.trailingStopPct).toFixed(2);

  // Only start trailing once price moves TRAILING_ACTIVATION_PCT in our favour
  const activePrice = action === "buy"
    ? (entryPrice * (1 + CONFIG.trailingActivationPct)).toFixed(2)
    : (entryPrice * (1 - CONFIG.trailingActivationPct)).toFixed(2);

  const src = atr ? `${CONFIG.atrMultiplier}×ATR($${parseFloat(atr).toFixed(4)})` : `${CONFIG.trailingStopPct * 100}% fixo`;
  console.log(`  Trailing stop: distance=$${trailingDistance} (${src}) | activa @ $${activePrice} (${(CONFIG.trailingActivationPct * 100).toFixed(2)}% de lucro)`);

  const timestamp  = Date.now().toString();
  const recvWindow = "5000";
  const body       = JSON.stringify({ category: "linear", symbol, trailingStop: trailingDistance, activePrice, positionIdx: 0 });
  const sig        = sign(timestamp, recvWindow, body);
  await fetch(`${CONFIG.bybit.baseUrl}/v5/position/trading-stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
}

// ─── Webhook endpoint ─────────────────────────────────────────────────────────

// Read raw body stream directly — works regardless of Content-Type.
// TradingView strategy alerts sometimes send no Content-Type header,
// which causes express.json() to silently skip parsing.
app.use((req, _res, next) => {
  let raw = "";
  req.on("data", chunk => { raw += chunk.toString("utf8"); });
  req.on("end", () => {
    if (raw) {
      try { req.body = JSON.parse(raw); }
      catch {
        console.log(`  ⚠️  JSON parse falhou — raw body: ${raw.substring(0, 300)}`);
        req.body = undefined;
      }
    }
    next();
  });
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", mode: CONFIG.paperTrading ? "paper" : "live", leverage: CONFIG.leverage });
});
app.get("/api/status", (req, res) => {
  res.json({ status: "ok", mode: CONFIG.paperTrading ? "paper" : "live", leverage: CONFIG.leverage });
});

// TradingView alert endpoint
// Expected payload: { "secret": "...", "action": "buy"|"sell", "symbol": "BTCUSDT", "price": 75000 }
app.post("/webhook", (req, res) => {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] Webhook received:`, JSON.stringify(req.body));

  if (!req.body || typeof req.body !== "object") {
    console.log("  ❌ Empty or non-JSON body — set Content-Type: application/json in TradingView alert");
    return res.status(400).json({ error: "Invalid body — must be JSON with Content-Type: application/json" });
  }

  // Validate secret before responding to avoid leaking info on invalid requests
  const secret = req.body?.secret;
  if (CONFIG.webhookSecret && secret !== CONFIG.webhookSecret) {
    console.log("  ❌ Invalid secret — rejected");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Respond immediately so TradingView doesn't time out (it has a ~3s limit).
  // Trade processing continues asynchronously in the background.
  res.json({ status: "received" });

  handleWebhook(req.body).catch(err => {
    console.log("  ❌ Unhandled error:", err.message);
  });
});

async function handleWebhook(body) {

  const { secret, action, symbol, price, leverage, entry_price, atr: payloadAtr } = body;

  // Validate required fields
  if (!action) {
    console.log("  ❌ Missing field: action");
    return;
  }

  if (!["buy", "sell", "tp"].includes(action.toLowerCase())) {
    console.log("  ❌ Invalid action:", action);
    return;
  }

  const actionLower   = action.toLowerCase();
  const sym           = symbol || process.env.SYMBOL || "BTCUSDT";
  const effectiveLev  = leverage ? parseInt(leverage) : CONFIG.leverage;

  // Use price from payload — but validate against live price.
  // If payload price differs by >10% from market, it's stale/wrong → use live price.
  let priceNum = parseFloat(price);
  if (!priceNum || isNaN(priceNum)) {
    console.log("  ℹ️  No price in payload — fetching live price from Bybit...");
    priceNum = await fetchCurrentPrice(sym);
  } else {
    const livePrice = await fetchCurrentPrice(sym);
    if (livePrice) {
      const diff = Math.abs(priceNum - livePrice) / livePrice;
      if (diff > 0.10) {
        console.log(`  ⚠️  Payload price $${priceNum} difere ${(diff*100).toFixed(1)}% do preço live $${livePrice} — a usar preço live`);
        priceNum = livePrice;
      }
    }
  }

  console.log(`  Signal: ${actionLower.toUpperCase()} ${sym} @ $${priceNum}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} | Size: $${CONFIG.tradeSize} | Leverage: ${effectiveLev}x${leverage ? " (payload)" : " (default)"} | SL: ${CONFIG.stopLossPct*100}% | TP: ${CONFIG.takeProfitPct*100}%`);

  // ── Take-profit: close half the active position ───────────────────────────
  if (actionLower === "tp") {
    console.log(`  🎯 TP signal — a fechar metade da posição em ${sym}...`);
    if (CONFIG.paperTrading) {
      console.log(`  📋 PAPER TP — nenhuma ordem enviada`);
      await sendTelegram(`📋 <b>Bot v2 ${sym}</b> — PAPER TP\nFecharia metade da posição`);
      return;
    }
    try {
      const openPos = await getOpenPosition(sym);
      if (!openPos) {
        console.log(`  ⚠️  Nenhuma posição aberta em ${sym} — TP ignorado`);
        await sendTelegram(`⚠️ <b>Bot v2 ${sym}</b> — TP ignorado\nNenhuma posição aberta`);
        return;
      }
      console.log(`  Posição: ${openPos.side} qty=${openPos.size} — a fechar metade...`);
      const result = await closeHalfPosition(sym, openPos);
      console.log(`  ✅ METADE FECHADA — orderId=${result.orderId} | fechado=${result.closedQty} | resta=${result.remainingQty}`);
      logTrade(sym, openPos.side === "Buy" ? "sell" : "buy", priceNum, "", result.orderId, "LIVE", `TP: closed half (${result.closedQty}), remaining ${result.remainingQty}`);

      // PnL da operação: (exit - entry) × qty fechada
      const entryNum = parseFloat(entry_price);
      const closedQtyNum = parseFloat(result.closedQty);
      let opPnl = null;
      if (entryNum && !isNaN(entryNum) && closedQtyNum > 0) {
        opPnl = openPos.side === "Buy"
          ? (priceNum - entryNum) * closedQtyNum
          : (entryNum - priceNum) * closedQtyNum;
        console.log(`  💰 PnL operação: ${opPnl >= 0 ? "+" : ""}$${opPnl.toFixed(2)} (entrada $${entryNum} → saída $${priceNum} × ${closedQtyNum})`);
      }

      // PnL do dia via Bybit closed-pnl
      let dailyPnl = null;
      try { dailyPnl = await getDailyClosedPnl(sym); } catch (_) {}

      // Progressive SL tightening — works for both long and short:
      //   TP1: current SL ≠ entry_price  → move SL to entry_price (break-even)
      //   TP2+: current SL ≈ entry_price → move SL to midpoint(currentSL, TP_price)
      //         midpoint moves SL up for longs, down for shorts — always tighter
      let newSl = null;
      if (entryNum && !isNaN(entryNum)) {
        try {
          // Re-fetch position to get current SL after the half-close settled
          const posAfter = await getOpenPosition(sym);
          const currentSl = posAfter?.stopLoss ?? 0;
          const tolerance = entryNum * 0.001; // 0.1% tolerance for float comparison
          const breakEvenSet = currentSl > 0 && Math.abs(currentSl - entryNum) <= tolerance;

          if (breakEvenSet) {
            // TP2+ — move SL halfway between current SL and this TP price
            newSl = parseFloat(((currentSl + priceNum) / 2).toFixed(2));
            console.log(`  ✅ SL progressivo (TP2+): $${currentSl} → $${newSl} (meio entre $${currentSl} e $${priceNum})`);
          } else {
            // TP1 — move SL to entry price (break-even)
            newSl = parseFloat(entryNum.toFixed(2));
            console.log(`  ✅ SL break-even (TP1): → $${newSl}`);
          }
          await setBreakEvenStop(sym, newSl);
        } catch (e) {
          console.log(`  ⚠️  Ajuste de SL falhou: ${e.message}`);
        }
      } else {
        console.log(`  ℹ️  entry_price não fornecido — SL não alterado`);
      }

      await sendTelegram(
        `🎯 <b>Take-Profit Bot v2</b> — ${sym}\n` +
        `Posição ${openPos.side} | Fechado: ${result.closedQty} | Resta: ${result.remainingQty}\n` +
        (newSl !== null ? `🛡 Novo SL: $${newSl}\n` : "") +
        (opPnl !== null ? `💰 PnL operação: ${opPnl >= 0 ? "+" : ""}$${opPnl.toFixed(2)}\n` : "") +
        (dailyPnl !== null ? `📊 PnL hoje (${sym}): $${dailyPnl.toFixed(2)}\n` : "")
      );
      return;
    } catch (err) {
      console.log(`  ❌ TP ERROR — ${err.message}`);
      await sendTelegram(`❌ <b>Bot v2 ${sym}</b> — Erro no TP\n${err.message}`);
      return;
    }
  }

  if (CONFIG.paperTrading) {
    const paperId = `PAPER-${Date.now()}`;
    console.log(`  📋 PAPER TRADE — ${actionLower.toUpperCase()} $${CONFIG.tradeSize} ${sym}`);
    logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, paperId, "PAPER", "Signal received");
    await sendTelegram(`📋 <b>Bot v2 ${sym}</b> — PAPER ${actionLower.toUpperCase()}\nPreço: $${priceNum} | Size: $${CONFIG.tradeSize}\nSL: ${CONFIG.stopLossPct*100}%`);
    return;
  }

  // ── Daily loss limit check ────────────────────────────────────────────────
  let dailyPnlLine = "";  // included in trade Telegram message if limits are configured
  if (CONFIG.maxDailyLossPerSymbol > 0 || CONFIG.maxDailyLossTotal > 0) {
    try {
      const [symbolPnl, totalPnl] = await Promise.all([
        CONFIG.maxDailyLossPerSymbol > 0 ? getDailyClosedPnl(sym) : Promise.resolve(0),
        CONFIG.maxDailyLossTotal      > 0 ? getDailyClosedPnl()   : Promise.resolve(0),
      ]);

      if (CONFIG.maxDailyLossPerSymbol > 0 && symbolPnl < -CONFIG.maxDailyLossPerSymbol) {
        const msg = `🛑 Limite de perda diária por par atingido em ${sym}: $${symbolPnl.toFixed(2)} (limite: -$${CONFIG.maxDailyLossPerSymbol})`;
        console.log(`  ${msg}`);
        await sendTelegram(`🛑 <b>Bot v2 ${sym}</b> — Bloqueado\n${msg}`);
        return;
      }

      if (CONFIG.maxDailyLossTotal > 0 && totalPnl < -CONFIG.maxDailyLossTotal) {
        const msg = `🛑 Limite de perda diária global atingido: $${totalPnl.toFixed(2)} (limite: -$${CONFIG.maxDailyLossTotal})`;
        console.log(`  ${msg}`);
        await sendTelegram(`🛑 <b>Bot v2</b> — Bloqueado (todos os pares)\n${msg}`);
        return;
      }

      dailyPnlLine = `📊 PnL hoje — ${sym}: $${symbolPnl.toFixed(2)} | Total: $${totalPnl.toFixed(2)}`;
      console.log(`  ${dailyPnlLine}`);
    } catch (e) {
      console.log(`  ⚠️  Não foi possível verificar PnL diário: ${e.message} — a continuar`);
    }
  }

  // Live execution
  try {
    if (CONFIG.tradeMode === "futures") {
      await setLeverage(sym, effectiveLev);
      console.log(`  Leverage set to ${effectiveLev}x`);

      const openPos = await getOpenPosition(sym);
      if (openPos) {
        const openSideLower = openPos.side.toLowerCase();
        if (openSideLower === actionLower) {
          console.log(`  ⚠️  Already ${openPos.side} (qty=${openPos.size}) — skipping duplicate signal`);
          logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, "", "SKIPPED", `Already ${openPos.side}`);
          await sendTelegram(`⏭ <b>Bot v2 ${sym}</b> — Sinal ignorado\nJá tem posição ${openPos.side} aberta (qty=${openPos.size})`);
          return;
        }
        console.log(`  🔄 Closing existing ${openPos.side} (qty=${openPos.size}) before opening ${actionLower.toUpperCase()}...`);
        const closeResult = await closePosition(sym, openPos);
        console.log(`  ✅ POSITION CLOSED — ${closeResult.orderId}`);
        logTrade(sym, openSideLower === "buy" ? "sell" : "buy", priceNum, CONFIG.tradeSize, closeResult.orderId, "LIVE", `Closed ${openPos.side} — reversing to ${actionLower}`);
      }
    }

    // Resolve ATR — payload first, then fetch from Bybit candles
    const atrNum = payloadAtr ? parseFloat(payloadAtr) : null;
    let resolvedAtr = atrNum;
    if (resolvedAtr) {
      console.log(`  ATR recebido do payload: $${resolvedAtr.toFixed(4)}`);
    } else {
      try {
        resolvedAtr = await fetchATR(sym);
        console.log(`  ATR(${CONFIG.atrPeriod},${CONFIG.candleInterval}m) calculado: $${resolvedAtr.toFixed(4)}`);
      } catch (e) {
        console.log(`  ⚠️  ATR fetch falhou: ${e.message} — SL fixo será usado`);
      }
    }

    // ── Volatility filter ─────────────────────────────────────────────────────
    if (resolvedAtr && CONFIG.maxSlPct > 0) {
      const slPct = (resolvedAtr * CONFIG.atrMultiplier) / priceNum;
      if (slPct > CONFIG.maxSlPct) {
        const slPctStr    = (slPct * 100).toFixed(2);
        const limitPctStr = (CONFIG.maxSlPct * 100).toFixed(1);
        const msg = `⏸ Sinal ignorado — mercado volátil: SL seria ${slPctStr}% > limite ${limitPctStr}%`;
        console.log(`  ${msg}`);
        await sendTelegram(
          `⏸ <b>Bot v2 ${sym}</b> — Sinal ignorado\n` +
          `Mercado demasiado volátil para entrar\n` +
          `ATR(${CONFIG.atrPeriod})=$${resolvedAtr.toFixed(4)} → SL seria ${slPctStr}%\n` +
          `Limite configurado: ${limitPctStr}%`
        );
        return;
      }
      console.log(`  ✅ Filtro volatilidade OK: SL ${((resolvedAtr * CONFIG.atrMultiplier / priceNum) * 100).toFixed(2)}% ≤ ${(CONFIG.maxSlPct * 100).toFixed(1)}%`);
    }

    const order = await placeOrder(sym, actionLower, priceNum, effectiveLev, resolvedAtr);
    console.log(`  ✅ ORDER PLACED — ${order.orderId}`);

    if (CONFIG.tradeMode === "futures") {
      await setTrailingStop(sym, actionLower, priceNum, resolvedAtr);
    }

    const slLabel = order.atrUsed
      ? `$${order.slPrice} (${(order.slPct * 100).toFixed(2)}% = ${CONFIG.atrMultiplier}×ATR)`
      : `$${order.slPrice} (${(order.slPct * 100).toFixed(2)}% fixo)`;

    logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, order.orderId, "LIVE", `SL=$${order.slPrice}`);
    await sendTelegram(
      `✅ <b>Bot v2 ${sym}</b> — LIVE ${actionLower.toUpperCase()}\n` +
      `Preço: $${priceNum} | Size: $${order.tradeSize ?? CONFIG.tradeSize}\n` +
      `SL: ${slLabel} | TP: via TradingView\n` +
      (dailyPnlLine ? `${dailyPnlLine}\n` : "")
    );

  } catch (err) {
    console.log(`  ❌ ERROR — ${err.message}`);
    logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, "", "ERROR", err.message);
    await sendTelegram(`❌ <b>Bot v2 ${sym}</b> — Erro na ordem\n${err.message}`);
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
  console.log(`  Trade    : $${CONFIG.tradeSize} per signal${CONFIG.riskPerTradeUSD > 0 ? ` (risk-based $${CONFIG.riskPerTradeUSD})` : ""}`);
  console.log(`  SL       : ATR(${CONFIG.atrPeriod}, ${CONFIG.candleInterval}m) × ${CONFIG.atrMultiplier} | fallback ${CONFIG.stopLossPct * 100}%`);
  console.log(`  Vol.filter: ${CONFIG.maxSlPct > 0 ? `skip se SL > ${(CONFIG.maxSlPct * 100).toFixed(1)}%` : "desativado (MAX_SL_PCT=0)"}`);
  console.log(`  Endpoint : POST /webhook`);
  console.log(`  Payload  : { "secret":"...", "action":"buy|sell", "symbol":"BTCUSDT", "price":75000, "atr":0.5 (opcional) }`);
  console.log("═══════════════════════════════════════════════════════════");
});
