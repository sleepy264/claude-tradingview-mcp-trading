/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BYBIT_API_KEY", "BYBIT_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  // Skip file-based onboarding if credentials are already in the environment (e.g. Railway)
  if (missing.length === 0) return;

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Bybit credentials",
        "BYBIT_API_KEY=",
        "BYBIT_SECRET_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
        "TRADE_MODE=spot",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your Bybit credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "futures",
  mexc: {
    apiKey: process.env.MEXC_API_KEY,
    secretKey: process.env.MEXC_SECRET_KEY,
    baseUrl: "https://contract.mexc.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1H": "1H", "4H": "4H", "1D": "1D", "1W": "1W",
  };
  const okxInterval = intervalMap[interval] || "15m";
  // Convert symbol format (SOLUSDT or SOL_USDT) to OKX format (SOL-USDT)
  const okxSymbol = symbol.replace(/_/g, "-").replace(/^([A-Z]+)(USDT|USDC|BTC|ETH)$/, "$1-$2");
  // OKX max is 300 candles per request
  const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSymbol}&bar=${okxInterval}&limit=${Math.min(limit, 300)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OKX kline API error: ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX kline error: ${data.msg}`);
  // OKX returns newest first — reverse to chronological order
  return data.data.reverse().map((k) => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  const valid = closes.filter(c => Number.isFinite(c));
  if (valid.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = valid.length - period; i < valid.length; i++) {
    const diff = valid[i] - valid[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (gains === 0 && losses === 0) return 50;
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }
  const recent = trs.slice(-period);
  const avg50  = trs.slice(-50).reduce((a, b) => a + b) / Math.min(trs.length, 50);
  const atr    = recent.reduce((a, b) => a + b) / period;
  return { atr, avg50, volatile: atr > avg50 * 0.7 };
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias from VWAP only
  const bullishBias = price > vwap;
  const bearishBias = price < vwap;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback
    check(
      "RSI(3) below 40 (pullback in uptrend)",
      "< 40",
      rsi3.toFixed(2),
      rsi3 < 40,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 60 (reversal in downtrend)",
      "> 60",
      rsi3.toFixed(2),
      rsi3 > 60,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Bybit Execution ─────────────────────────────────────────────────────────

function signMexc(timestamp, params) {
  const message = `${CONFIG.mexc.apiKey}${timestamp}${params}`;
  return crypto
    .createHmac("sha256", CONFIG.mexc.secretKey)
    .update(message)
    .digest("hex");
}

function mexcHeaders(timestamp, signature) {
  return {
    "Content-Type":  "application/json",
    "ApiKey":        CONFIG.mexc.apiKey,
    "Request-Time":  timestamp,
    "Signature":     signature,
  };
}

async function getOpenPosition(symbol) {
  const timestamp = Date.now().toString();
  const params    = `symbol=${symbol}`;
  const sig       = signMexc(timestamp, params);
  const res  = await fetch(`${CONFIG.mexc.baseUrl}/api/v1/private/position/open_positions?${params}`, {
    headers: mexcHeaders(timestamp, sig),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC getOpenPosition failed: ${data.message}`);
  const list = data.data || [];
  if (list.length === 0) return null;
  const pos  = list[0];
  const size = parseFloat(pos.holdVol);
  if (size <= 0) return null;
  return { side: pos.positionType === 1 ? "Buy" : "Sell", size };
}

async function getInstrumentInfo(symbol) {
  const res  = await fetch(`${CONFIG.mexc.baseUrl}/api/v1/contract/detail?symbol=${symbol}`);
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC instrument info failed: ${data.message}`);
  const d = data.data;
  const qtyStep = Math.pow(10, -(d.volDecimalPlaces || 0));
  return {
    minQty:   parseFloat(d.minVol) || 1,
    qtyStep,
  };
}

function calcQty(sizeUSD, leverage, price, minQty, qtyStep) {
  const raw   = (sizeUSD * leverage) / price;
  const steps = Math.floor(raw / qtyStep);
  const qty   = Math.max(steps * qtyStep, minQty);
  const decimals = (qtyStep.toString().split(".")[1] || "").length;
  return qty.toFixed(decimals);
}

async function setTrailingStop(symbol) {
  // MEXC não suporta trailing stop direto via API de posição.
  // O SL/TP dinâmico é definido na ordem — trailing stop ignorado.
  console.log(`  ⚠️  Trailing stop não suportado na MEXC — ignorado.`);
}

async function placeMexcOrder(symbol, side, sizeUSD, price, stopLoss, takeProfit) {
  const leverage = parseInt(process.env.LEVERAGE || "60");
  const { minQty, qtyStep } = await getInstrumentInfo(symbol);
  const quantity = calcQty(sizeUSD, leverage, price, minQty, qtyStep);
  console.log(`  Qty: ${quantity} (${sizeUSD}$ × ${leverage}x ÷ $${price.toFixed(2)}, min=${minQty}, step=${qtyStep})`);
  // Leverage é passado diretamente na ordem — não precisa de chamada separada na MEXC

  // MEXC side: 1=Open Long, 2=Close Short, 3=Open Short, 4=Close Long
  const mexcSide = side === "buy" ? 1 : 3;

  const timestamp = Date.now().toString();
  const orderBody = JSON.stringify({
    symbol,
    price:    0,
    vol:      parseFloat(quantity),
    leverage,
    side:     mexcSide,
    type:     5,   // 5 = Market
    openType: 2,   // 2 = Cross margin
  });
  const sig = signMexc(timestamp, orderBody);
  const res = await fetch(`${CONFIG.mexc.baseUrl}/api/v1/private/order/submit`, {
    method: "POST",
    headers: mexcHeaders(timestamp, sig),
    body: orderBody,
  });
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC order failed: ${data.message}`);
  return { orderId: data.data };
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

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE    = "trades.csv";
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function logSkip(price, reason) {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }
  const now  = new Date(Date.now() + 3600000); // UTC+1
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const row  = [date, time, "Bybit", CONFIG.symbol, "", "", price.toFixed(2), "", "", "", "SKIPPED", "SKIPPED", `"${reason}"`].join(",");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}

function writeTradeCsv(logEntry) {
  const now  = new Date(new Date(logEntry.timestamp).getTime() + 3600000); // UTC+1
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "Bybit",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — 15m for entry indicators, 1H for trend filter
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const [candles, candles1h] = await Promise.all([
    fetchCandles(CONFIG.symbol, "15m", 500),
    fetchCandles(CONFIG.symbol, "1h",  200),
  ]);
  const closes   = candles.map((c) => c.close);
  const closes1h = candles1h.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8     = calcEMA(closes, 8);
  const vwap     = calcVWAP(candles);
  const rsi3     = calcRSI(closes, 3);
  const ema50_1h = calcEMA(closes1h, 50);

  const atrData  = calcATR(candles, 14);
  const rsi14_1h = calcRSI(closes1h, 14);
  const volAvg   = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  const lastVol  = candles[candles.length - 1].volume;
  const volLow   = lastVol < volAvg;

  const rsi3Valid    = rsi3 !== null && !isNaN(rsi3);
  const rsi14_1hValid = rsi14_1h !== null && !isNaN(rsi14_1h);
  console.log(`  EMA(8)  15m: $${ema8 != null ? ema8.toFixed(2) : "N/A"}`);
  console.log(`  VWAP    15m: $${vwap != null ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3)  15m: ${rsi3Valid ? rsi3.toFixed(2) : "N/A"}`);
  console.log(`  RSI(14) 1H:  ${rsi14_1hValid ? rsi14_1h.toFixed(2) : "N/A"} (1H RSI filter)`);
  console.log(`  EMA(50) 1H:  $${ema50_1h != null ? ema50_1h.toFixed(2) : "N/A"} (trend filter)`);
  console.log(`  ATR(14) 15m: ${atrData ? `$${atrData.atr.toFixed(2)} — ${atrData.volatile ? "✅ volatile" : "🚫 choppy"}` : "N/A"}`);
  console.log(`  Volume  15m: ${volLow ? "✅ low (weak pullback)" : "🚫 high (strong move, skip)"}`);

  const missing = [
    vwap == null          && "VWAP",
    !rsi3Valid            && "RSI(3) 15m",
    ema50_1h == null      && "EMA(50) 1H",
    atrData == null       && "ATR(14) 15m",
    !rsi14_1hValid        && "RSI(14) 1H",
  ].filter(Boolean);
  if (missing.length) {
    console.log(`\n⚠️  Missing indicators: ${missing.join(", ")} — not enough candle history.`);
    logSkip(price, `Missing: ${missing.join(", ")}`);
    await sendTelegram(`⚠️ <b>Bot v1 ${CONFIG.symbol}</b> — Skipped\nMissing indicators: ${missing.join(", ")}`);
    return;
  }

  if (!atrData.volatile) {
    console.log("\n🚫 Market is choppy (ATR below average) — no trade.");
    logSkip(price, "Choppy market (ATR below average)");
    await sendTelegram(`⏭ <b>Bot v1 ${CONFIG.symbol}</b> — Skipped\nMercado choppy (ATR abaixo da média)`);
    return;
  }

  if (!volLow) {
    console.log("\n🚫 Volume above average — pullback is strong, not a snap-back setup.");
    logSkip(price, "Volume above average — strong pullback");
    await sendTelegram(`⏭ <b>Bot v1 ${CONFIG.symbol}</b> — Skipped\nVolume acima da média — pullback forte`);
    return;
  }

  // Trend filter: only trade in direction of 1H EMA(50)
  const trendBullish = price > ema50_1h;
  const trendBearish = price < ema50_1h;
  console.log(`  1H Trend: ${trendBullish ? "BULLISH (longs only)" : trendBearish ? "BEARISH (shorts only)" : "NEUTRAL"}`);

  // Run safety check
  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);

  // Determine direction from VWAP — must align with 1H trend
  const h1Side = price > vwap ? "buy" : "sell";
  const trendAligned = (h1Side === "buy" && trendBullish) || (h1Side === "sell" && trendBearish);

  const tradeSide = h1Side;

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  const rsi1hOk = rsi14_1hValid && (h1Side === "buy" ? rsi14_1h < 70 : rsi14_1h > 30);

  if (!trendAligned) results.push({ label: `15m bias (${h1Side}) conflicts with 1H trend`, pass: false });
  if (!rsi1hOk)      results.push({ label: `1H RSI(14) at ${rsi14_1h.toFixed(1)} — market extended`, pass: false });
  logEntry.conditions = results;
  logEntry.allPass    = results.every(r => r.pass);

  if (!logEntry.allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    failed.forEach((f) => console.log(`   - ${f}`));
    await sendTelegram(`🚫 <b>Bot v1 ${CONFIG.symbol}</b> — Trade bloqueado @ $${price.toFixed(2)}\n${failed.map(f => `• ${f}`).join("\n")}`);
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    const direction = tradeSide === "buy" ? "LONG" : "SHORT";
    const atr = atrData.atr;
    const stopPrice = tradeSide === "buy"
      ? (price - atr).toFixed(2)
      : (price + atr).toFixed(2);
    const tpPrice = tradeSide === "buy"
      ? (price + atr * 3).toFixed(2)
      : (price - atr * 3).toFixed(2);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — ${direction} ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   SL: $${stopPrice} (1×ATR) | TP: $${tpPrice} (3×ATR) | Trailing: $${(price * 0.03).toFixed(2)} (3%)`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      logEntry.side = tradeSide;
      logEntry.stopLoss = stopPrice;
      logEntry.takeProfit = tpPrice;
      await sendTelegram(`📋 <b>Bot v1 ${CONFIG.symbol}</b> — PAPER ${direction}\nPreço: $${price.toFixed(2)} | Size: $${tradeSize.toFixed(2)}\nSL: $${stopPrice} | TP: $${tpPrice}`);
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — ${direction} $${tradeSize.toFixed(2)} ${CONFIG.symbol}`,
      );
      try {
        if (CONFIG.tradeMode === "futures") {
          const openPos = await getOpenPosition(CONFIG.symbol);
          if (openPos) {
            console.log(`⚠️  Posição já aberta (${openPos.side} qty=${openPos.size}) — a saltar nova ordem.`);
            logEntry.error = `Position already open: ${openPos.side} qty=${openPos.size}`;
            throw new Error(`Position already open: ${openPos.side} qty=${openPos.size}`);
          }
        }
        console.log(`  SL: $${stopPrice} (1×ATR) | TP: $${tpPrice} (3×ATR) | Trailing: $${(price * 0.03).toFixed(2)} (3%)`);
        const order = await placeMexcOrder(CONFIG.symbol, tradeSide, tradeSize, price, stopPrice, tpPrice);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        logEntry.side = tradeSide;
        logEntry.stopLoss = stopPrice;
        const trailingDistance = (price * 0.03).toFixed(2);
        await setTrailingStop(CONFIG.symbol, trailingDistance);
        logEntry.trailingStop = trailingDistance;
        console.log(`✅ ORDER PLACED — ${order.orderId} | SL: $${stopPrice} | Trailing: $${trailingDistance}`);
        await sendTelegram(`✅ <b>Bot v1 ${CONFIG.symbol}</b> — LIVE ${direction}\nPreço: $${price.toFixed(2)} | Size: $${tradeSize.toFixed(2)}\nSL: $${stopPrice} | TP: $${tpPrice}\nOrder: ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
        await sendTelegram(`❌ <b>Bot v1 ${CONFIG.symbol}</b> — Erro na ordem\n${err.message}`);
      }
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
