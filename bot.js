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
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "fs";
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
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD  || "100"),
  riskPerTradeUSD: parseFloat(process.env.RISK_PER_TRADE_USD  || "0"),   // 0 = fixed size
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "futures",
  // Conditional reversal: if an opposite position is open, only close+reverse if
  // unrealized loss is below this threshold. 0 = only reverse if in profit/break-even.
  maxReversalLossUSD: parseFloat(process.env.MAX_REVERSAL_LOSS_USD || "1"),
  // Cooldown after SL: wait this many ms before opening a new position on the same symbol.
  // Prevents re-entering immediately into the same bounce that triggered the SL.
  cooldownAfterSlMs: parseInt(process.env.COOLDOWN_AFTER_SL_MS || "900000"), // 15 min
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

// ─── Market Data ─────────────────────────────────────────────────────────────
// Primary source: OKX public API (good for most crypto pairs)
// Fallback: MEXC contract public API (used for pairs OKX doesn't carry, e.g. WTIUSDT)

async function fetchCandlesOkx(symbol, interval, limit) {
  const intervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1H", "1H": "1H", "4h": "4H", "4H": "4H", "1D": "1D", "1W": "1W",
  };
  const okxInterval = intervalMap[interval] || "15m";
  const okxSymbol   = symbol.replace(/_/g, "-").replace(/^([A-Z]+)(USDT|USDC|BTC|ETH)$/, "$1-$2");
  const url  = `https://www.okx.com/api/v5/market/candles?instId=${okxSymbol}&bar=${okxInterval}&limit=${Math.min(limit, 300)}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`OKX kline API error: ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX kline error: ${data.msg}`);
  return data.data.reverse().map((k) => ({
    time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

async function fetchCandlesMexc(symbol, interval, limit) {
  const intervalMap = {
    "1m": "Min1", "5m": "Min5", "15m": "Min15", "30m": "Min30",
    "1h": "Min60", "1H": "Min60", "4h": "Hour4", "4H": "Hour4",
    "1D": "Day1", "1W": "Week1",
  };
  const mexcInterval = intervalMap[interval] || "Min15";
  // Fetch enough history: each candle = interval duration
  const intervalMs = { Min1:60,Min5:300,Min15:900,Min30:1800,Min60:3600,Hour4:14400,Day1:86400,Week1:604800 };
  const seconds    = intervalMs[mexcInterval] || 900;
  const end        = Math.floor(Date.now() / 1000);
  const start      = end - seconds * limit;
  const url  = `${CONFIG.mexc.baseUrl}/api/v1/contract/kline/${symbol}?interval=${mexcInterval}&start=${start}&end=${end}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`MEXC kline API error: ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC kline error: ${data.message}`);
  const d = data.data;
  // MEXC returns parallel arrays: time[], open[], high[], low[], close[], vol[]
  return d.time.map((t, i) => ({
    time:   t * 1000,
    open:   parseFloat(d.open[i]),
    high:   parseFloat(d.high[i]),
    low:    parseFloat(d.low[i]),
    close:  parseFloat(d.close[i]),
    volume: parseFloat(d.vol[i]),
  }));
}

async function fetchCandles(symbol, interval, limit = 100) {
  try {
    return await fetchCandlesOkx(symbol, interval, limit);
  } catch (e) {
    if (e.message.includes("doesn't exist") || e.message.includes("does not exist")) {
      console.log(`  ℹ️  OKX não tem ${symbol} — a usar MEXC como fonte de dados`);
      return await fetchCandlesMexc(symbol, interval, limit);
    }
    throw e;
  }
}

// Returns "bullish", "bearish", or null (if unavailable / non-crypto pair)
// BTC correlation is only meaningful for crypto assets — skip for commodities,
// forex, indices, etc.
const CRYPTO_QUOTE = /^[A-Z0-9]+(USDT|USDC|BTC|ETH|BUSD)$/i;
const NON_CRYPTO   = /^(USOIL|OIL|WTI|GOLD|XAU|SILVER|XAG|GAS|NATGAS|SPX|NDX|DJI|EUR|GBP|JPY)/i;

async function fetchBtcTrend() {
  const sym = CONFIG.symbol.replace("_", "");
  if (sym.startsWith("BTC") || NON_CRYPTO.test(CONFIG.symbol)) return null;
  try {
    const candles = await fetchCandlesOkx("BTCUSDT", "1h", 100);
    const closes  = candles.map(c => c.close);
    const ema20   = calcEMA(closes, 20);
    const btcPrice = closes[closes.length - 1];
    if (ema20 == null) return null;
    return btcPrice > ema20 ? "bullish" : "bearish";
  } catch (e) {
    console.log(`  ⚠️  BTC trend indisponível: ${e.message}`);
    return null;
  }
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

/**
 * Cross-validate RSI(3) extreme values against actual candle closes.
 * RSI(3)=0 should mean the last 3 candles all closed lower than the previous.
 * RSI(3)=100 should mean the last 3 candles all closed higher than the previous.
 * If the candle evidence contradicts the extreme value, the signal is likely a
 * data artefact — return { valid: false } so the caller substitutes RSI(14).
 *
 * @param {number}   rsi3   — the RSI(3) value (0 or 100 triggers the check)
 * @param {number[]} closes — array of close prices (most-recent last)
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateRsi3(rsi3, closes) {
  const isExtreme = rsi3 === 0 || rsi3 === 100;
  if (!isExtreme) return { valid: true };

  const needed = 4; // need at least 4 closes to compare 3 consecutive pairs
  if (closes.length < needed) return { valid: true }; // can't verify → accept

  // Last 3 closes and the candle before them
  const slice = closes.slice(-needed); // [c0, c1, c2, c3]  c3 = most recent
  const pairs = [[slice[0], slice[1]], [slice[1], slice[2]], [slice[2], slice[3]]];

  if (rsi3 === 0) {
    // Expect each close < previous close (all down)
    const allDown = pairs.every(([prev, curr]) => curr < prev);
    if (!allDown) {
      const pctDown = pairs.filter(([p, c]) => c < p).length;
      return {
        valid: false,
        reason: `RSI(3)=0 mas apenas ${pctDown}/3 candles decrescentes — substituindo por RSI(14)`,
      };
    }
  } else {
    // rsi3 === 100 — expect each close > previous close (all up)
    const allUp = pairs.every(([prev, curr]) => curr > prev);
    if (!allUp) {
      const pctUp = pairs.filter(([p, c]) => c > p).length;
      return {
        valid: false,
        reason: `RSI(3)=100 mas apenas ${pctUp}/3 candles crescentes — substituindo por RSI(14)`,
      };
    }
  }

  return { valid: true };
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

    // For mean-reversion shorts: wait for the bounce ABOVE EMA(8) before shorting.
    // When RSI(3) > 60 in a downtrend the price is bouncing up — naturally above EMA(8).
    // Requiring price < EMA(8) contradicts RSI > 60 and blocks every valid short setup.
    check(
      "Price above EMA(8) (bounce into short)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
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

  const tradeSize = CONFIG.maxTradeSizeUSD;

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

// ─── In-memory daily PnL tracker ─────────────────────────────────────────────
// Calculated from entry/exit prices — no MEXC API call needed.
// PnL = (exitPrice - entryPrice) / entryPrice × tradeSize × leverage  (long)
// PnL = (entryPrice - exitPrice) / entryPrice × tradeSize × leverage  (short)
// Persisted to daily-pnl.json so restarts don't reset the daily total.

const PNL_FILE = "daily-pnl.json";

function _todayUTC() { return new Date().toISOString().slice(0, 10); }

function _loadDailyPnl() {
  try {
    if (existsSync(PNL_FILE)) {
      const data = JSON.parse(readFileSync(PNL_FILE, "utf8"));
      if (data.date === _todayUTC()) return data;
    }
  } catch {}
  return { date: _todayUTC(), total: 0 };
}

function _saveDailyPnl(pnl) {
  try { writeFileSync(PNL_FILE, JSON.stringify(pnl)); } catch {}
}

let _dailyPnl = _loadDailyPnl();  // survives restarts within the same day

function getDailyClosedPnl() {
  if (_dailyPnl.date !== _todayUTC()) {
    _dailyPnl = { date: _todayUTC(), total: 0 };
    _saveDailyPnl(_dailyPnl);
  }
  return _dailyPnl.total;
}

function addDailyPnl(entryPrice, exitPrice, side, tradeSize, leverage, fraction = 1) {
  if (_dailyPnl.date !== _todayUTC()) _dailyPnl = { date: _todayUTC(), total: 0 };
  const pct = side === "buy"
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;
  const pnl = pct * tradeSize * leverage * fraction;
  _dailyPnl.total += pnl;
  _saveDailyPnl(_dailyPnl);
  console.log(`  📊 PnL sessão: $${_dailyPnl.total.toFixed(2)} (este fecho: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)})`);
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

  // Log raw position fields once so we can confirm the exact MEXC field names
  const pnlFields = Object.fromEntries(
    Object.entries(pos).filter(([k]) => /pnl|profit|loss/i.test(k))
  );
  console.log(`  [debug] MEXC pos PnL fields: ${JSON.stringify(pnlFields)}`);

  // Try known MEXC field names; if none found, set to null (unknown — not 0)
  const rawPnl = pos.unrealisedPnl ?? pos.unrealizedPnl ?? pos.unRealizedPnl
               ?? pos.positionPnl ?? pos.openPositionPnl ?? null;
  const unrealizedPnl = rawPnl !== null ? parseFloat(rawPnl) : null;

  return { side: pos.positionType === 1 ? "Buy" : "Sell", size, unrealizedPnl };
}

async function getInstrumentInfo(symbol) {
  const res  = await fetch(`${CONFIG.mexc.baseUrl}/api/v1/contract/detail?symbol=${symbol}`);
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC instrument info failed: ${data.message}`);
  const d = data.data;
  const qtyStep    = Math.pow(10, -(d.volDecimalPlaces || 0));
  const contractSize = parseFloat(d.contractSize) || 1;
  return {
    minQty: parseFloat(d.minVol) || 1,
    qtyStep,
    contractSize,
  };
}

// Reduce leverage automatically when ATR is elevated vs its 50-period average:
//   ATR <= avg50        → full leverage
//   ATR 1.0–1.5 × avg50 → 75%
//   ATR > 1.5 × avg50   → 50%
// Risk-based position sizing: calculates the margin (tradeSize) needed so that
// if SL (1.5×ATR) is hit, the dollar loss equals exactly riskUSD.
// Formula: loss = (tradeSize × leverage) × (1.5×ATR / price) = riskUSD
//          tradeSize = riskUSD × price / (leverage × 1.5 × ATR)
// Result is capped at maxTradeSize.
function calcRiskBasedTradeSize(riskUSD, price, atr, leverage, maxTradeSize) {
  const slDistance = atr * 1.5;
  const sized = (riskUSD * price) / (leverage * slDistance);
  const capped = Math.min(sized, maxTradeSize);
  return parseFloat(capped.toFixed(2));
}

function calcEffectiveLeverage(atr, avg50) {
  const base  = parseInt(process.env.LEVERAGE || "60");
  const ratio = atr / avg50;
  if (ratio > 1.5) return Math.floor(base * 0.5);
  if (ratio > 1.0) return Math.floor(base * 0.75);
  return base;
}

function calcQty(sizeUSD, leverage, price, minQty, qtyStep, contractSize = 1) {
  // vol (lots) = notional / (price * contractSize)
  // notional   = sizeUSD * leverage
  const raw   = (sizeUSD * leverage) / (price * contractSize);
  const steps = Math.floor(raw / qtyStep);
  const qty   = Math.max(steps * qtyStep, minQty);
  const decimals = (qtyStep.toString().split(".")[1] || "").length;
  return qty.toFixed(decimals);
}

// ─── Position State (for break-even tracking) ────────────────────────────────

const STATE_FILE = "position_state.json";

function loadPositionState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch (e) {}
  return null;
}

function savePositionState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearPositionState() {
  try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch (e) {}
}

// ─── Cooldown state (persists across Railway restarts) ────────────────────────

const COOLDOWN_FILE = "cooldown-state.json";

function recordSlHit(symbol) {
  try {
    writeFileSync(COOLDOWN_FILE, JSON.stringify({ symbol, slHitAt: Date.now() }, null, 2));
  } catch (e) {}
}

function checkCooldown(symbol) {
  if (CONFIG.cooldownAfterSlMs <= 0) return { blocked: false };
  try {
    if (!existsSync(COOLDOWN_FILE)) return { blocked: false };
    const { symbol: s, slHitAt } = JSON.parse(readFileSync(COOLDOWN_FILE, "utf8"));
    if (s !== symbol) return { blocked: false };
    const elapsed = Date.now() - slHitAt;
    if (elapsed < CONFIG.cooldownAfterSlMs) {
      const remainingSec = Math.ceil((CONFIG.cooldownAfterSlMs - elapsed) / 1000);
      return { blocked: true, remainingSec };
    }
    // Cooldown expired — clean up
    try { unlinkSync(COOLDOWN_FILE); } catch (e) {}
  } catch (e) {}
  return { blocked: false };
}

// ─── Cancel a MEXC plan order ─────────────────────────────────────────────────

async function cancelMexcPlanOrder(symbol, planOrderId) {
  const timestamp = Date.now().toString();
  const body = JSON.stringify({ symbol, planOrderId });
  const sig  = signMexc(timestamp, body);
  const res  = await fetch(`${CONFIG.mexc.baseUrl}/api/v1/private/planorder/cancel`, {
    method:  "POST",
    headers: mexcHeaders(timestamp, sig),
    body,
  });
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC cancel plan order failed: ${data.message}`);
}

// ─── Break-even check ─────────────────────────────────────────────────────────
// Called every cycle. If an open position has moved ≥ 1×ATR in our favour and
// break-even hasn't been set yet, moves slPrice in position_state.json to the
// entry price. checkSlTp() will then use that updated value in subsequent cycles.

async function checkBreakEven(symbol, currentPrice, atr) {
  const state = loadPositionState();
  if (!state || state.breakEvenSet) return; // nothing to do

  // Confirm position is still open
  const pos = await getOpenPosition(symbol).catch(() => null);
  if (!pos) {
    console.log(`  ℹ️  Posição fechada — a limpar estado.`);
    clearPositionState();
    return;
  }

  const { side, entryPrice } = state;
  const movedFavorably = side === "buy"
    ? currentPrice >= entryPrice + atr
    : currentPrice <= entryPrice - atr;

  if (!movedFavorably) {
    const dist = side === "buy"
      ? (currentPrice - entryPrice).toFixed(2)
      : (entryPrice - currentPrice).toFixed(2);
    console.log(`  ⏳ Break-even ainda não atingido — posição ${side} @ $${entryPrice} | ganho atual: $${dist} | necessário: $${atr.toFixed(2)} (1×ATR)`);
    return;
  }

  // Move soft SL to entry price — no API call needed, just update the state file
  console.log(`  🎯 Break-even ativado! Preço moveu ≥ 1×ATR. A mover SL para entrada @ $${entryPrice}...`);
  state.slPrice      = entryPrice;
  state.breakEvenSet = true;
  savePositionState(state);
  console.log(`  ✅ SL movido para $${entryPrice} (break-even) — checkSlTp usará este valor nos próximos ciclos`);
  await sendTelegram(
    `🎯 <b>Break-even ativado</b> — ${symbol}\n` +
    `Preço atual: $${currentPrice.toFixed(2)}\n` +
    `SL movido para entrada @ $${entryPrice}`
  );
}

// Trailing stop after break-even: tracks highest/lowest price reached and
// moves SL to (peak - 1×ATR) for longs or (trough + 1×ATR) for shorts.
// Only activates once breakEvenSet=true. SL only ever moves in our favour.
async function checkTrailingStop(symbol, currentPrice, atr) {
  const state = loadPositionState();
  if (!state || !state.breakEvenSet) return; // only after break-even

  // Confirm position is still open — user may have closed it manually
  const pos = await getOpenPosition(symbol).catch(() => null);
  if (!pos) {
    console.log(`  ℹ️  Trailing stop: posição já não existe — a limpar estado.`);
    clearPositionState();
    await sendTelegram(
      `ℹ️ <b>Posição fechada externamente</b> — ${symbol}\n` +
      `Nenhuma posição aberta detectada — estado limpo.\n` +
      `(SL não foi alterado)`
    );
    return;
  }

  const { side, entryPrice, slPrice } = state;
  const trailHigh = state.trailHigh ?? currentPrice;
  const trailLow  = state.trailLow  ?? currentPrice;

  let newSl = slPrice;
  let updated = false;

  if (side === "buy") {
    const newHigh = Math.max(trailHigh, currentPrice);
    const candidate = parseFloat((newHigh - atr).toFixed(2));
    if (candidate > slPrice) {
      newSl = candidate;
      updated = true;
      console.log(`  📈 Trailing SL atualizado: $${slPrice} → $${newSl} (high=$${newHigh.toFixed(2)} − 1×ATR)`);
    }
    state.trailHigh = newHigh;
  } else {
    const newLow = Math.min(trailLow, currentPrice);
    const candidate = parseFloat((newLow + atr).toFixed(2));
    if (candidate < slPrice) {
      newSl = candidate;
      updated = true;
      console.log(`  📉 Trailing SL atualizado: $${slPrice} → $${newSl} (low=$${newLow.toFixed(2)} + 1×ATR)`);
    }
    state.trailLow = newLow;
  }

  if (updated) {
    state.slPrice = newSl;
    await sendTelegram(
      `📈 <b>Trailing SL</b> — ${symbol}\n` +
      `SL movido: $${slPrice} → $${newSl}\n` +
      `Preço atual: $${currentPrice.toFixed(2)}`
    );
  }
  savePositionState(state);
}

// Place a trigger (plan) order to close a position at SL or TP price.
// triggerType: 1 = mark price, 2 = last price (direction inferred by MEXC:
//   triggerPrice < current → fires on drop; triggerPrice > current → fires on rise)
async function placeMexcPlanOrder(symbol, closeSide, vol, triggerPrice, leverage) {
  const timestamp = Date.now().toString();
  // Close orders don't need leverage/openType (those are for opening positions).
  // executedPrice "0" is required by MEXC even for market-triggered orders.
  const body = JSON.stringify({
    symbol,
    side:          closeSide,
    vol:           parseFloat(vol),
    triggerPrice:  parseFloat(triggerPrice),
    triggerType:   2,   // 2 = last price
    executedPrice: "0", // required even for market orders (orderType=2)
    orderType:     2,   // 2 = market on trigger
  });
  const sig = signMexc(timestamp, body);
  const res = await fetch(`${CONFIG.mexc.baseUrl}/api/v1/private/planorder/place`, {
    method: "POST",
    headers: mexcHeaders(timestamp, sig),
    body,
  });
  const data = await res.json();
  // Log full response to help diagnose any remaining errors
  if (!data.success) {
    console.log(`  ⚠️  Plan order full response: ${JSON.stringify(data)}`);
    throw new Error(`MEXC plan order failed: ${data.message}`);
  }
  return data.data; // planOrderId
}

async function placeMexcOrder(symbol, side, sizeUSD, price, stopLoss, tp1Price, tp2Price, leverage) {
  leverage = leverage ?? parseInt(process.env.LEVERAGE || "60");
  const { minQty, qtyStep, contractSize } = await getInstrumentInfo(symbol);
  const quantity = calcQty(sizeUSD, leverage, price, minQty, qtyStep, contractSize);
  console.log(`  Qty: ${quantity} (${sizeUSD}$ × ${leverage}x ÷ ($${price.toFixed(2)} × contractSize=${contractSize}), min=${minQty}, step=${qtyStep})`);

  // MEXC side: 1=Open Long, 2=Close Short, 3=Open Short, 4=Close Long
  const mexcSide = side === "buy" ? 1 : 3;

  // Plain market order — SL/TP monitored by the bot each cycle (soft SL/TP)
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
  if (!data.success) throw new Error(`MEXC order failed: ${data.message} (code ${data.code})`);
  const orderId = data.data;

  // Persist SL/TP levels so the bot monitors and closes the position each cycle
  savePositionState({
    symbol,
    side,
    entryPrice:   price,
    slPrice:      parseFloat(stopLoss),
    tp1Price:     parseFloat(tp1Price),
    tp2Price:     parseFloat(tp2Price),
    halfClosed:   false,
    breakEvenSet: false,
    tradeSize:    parseFloat(sizeUSD),
    leverage,
  });
  console.log(`  📌 Estado gravado: SL=$${stopLoss} | TP1=$${tp1Price} (3×ATR) | TP2=$${tp2Price} (5×ATR)`);

  return { orderId };
}

async function closeHalfPosition(symbol, side, leverage) {
  leverage = leverage ?? parseInt(process.env.LEVERAGE || "60");
  const pos = await getOpenPosition(symbol);
  if (!pos) { clearPositionState(); return null; }

  const { minQty, qtyStep } = await getInstrumentInfo(symbol);
  const decimals = (qtyStep.toString().split(".")[1] || "").length;
  const halfRaw  = pos.size / 2;
  const halfQty  = Math.max(Math.floor(halfRaw / qtyStep) * qtyStep, minQty);
  if (halfQty <= 0) throw new Error(`Half qty (${halfQty}) é zero — posição demasiado pequena para dividir`);

  const closeSide = side === "buy" ? 4 : 2; // 4=Close Long, 2=Close Short
  const timestamp = Date.now().toString();
  const body = JSON.stringify({
    symbol,
    price:    0,
    vol:      halfQty,
    leverage,
    side:     closeSide,
    type:     5,
    openType: 2,
  });
  const sig = signMexc(timestamp, body);
  const res = await fetch(`${CONFIG.mexc.baseUrl}/api/v1/private/order/submit`, {
    method: "POST",
    headers: mexcHeaders(timestamp, sig),
    body,
  });
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC half-close failed: ${data.message}`);
  console.log(`  ✅ Metade fechada — qty=${halfQty.toFixed(decimals)} (orderId=${data.data})`);
  return { orderId: data.data, closedQty: halfQty.toFixed(decimals) };
}

// ─── Soft SL/TP: close position if price crosses SL or TP ────────────────────
// Called every cycle. MEXC rejects exchange-native SL/TP orders (codes 2007/5003)
// so we monitor the levels here and fire a market close order when hit.

async function closePosition(symbol, side, reason) {
  const pos = await getOpenPosition(symbol);
  if (!pos) {
    // Position no longer exists on the exchange (closed externally or already filled).
    // Must clear state here — otherwise checkSlTp will loop forever on the stale entry.
    console.log(`  ℹ️  Posição já fechada na exchange — a limpar estado.`);
    clearPositionState();
    return;
  }
  const closeSide  = side === "buy" ? 4 : 2; // 4=Close Long, 2=Close Short
  const closeLev   = parseInt(process.env.LEVERAGE || "60");
  const timestamp  = Date.now().toString();
  const body = JSON.stringify({
    symbol,
    price:    0,
    vol:      pos.size,
    leverage: closeLev,
    side:     closeSide,
    type:     5,   // Market
    openType: 2,
  });
  const sig = signMexc(timestamp, body);
  const res = await fetch(`${CONFIG.mexc.baseUrl}/api/v1/private/order/submit`, {
    method: "POST",
    headers: mexcHeaders(timestamp, sig),
    body,
  });
  const data = await res.json();
  if (!data.success) throw new Error(`MEXC close failed: ${data.message}`);
  console.log(`  ✅ Posição fechada — ${reason} (orderId=${data.data})`);
  clearPositionState();
  return data.data;
}

async function checkSlTp(symbol, currentPrice) {
  const state = loadPositionState();
  if (!state || !state.slPrice) return;

  const { side, slPrice, entryPrice, halfClosed, tp1Price, tp2Price,
          tradeSize = CONFIG.maxTradeSizeUSD,
          leverage  = parseInt(process.env.LEVERAGE || "60") } = state;
  // Support old state files that only have tpPrice
  const tp1 = tp1Price ?? state.tpPrice;
  const tp2 = tp2Price ?? null;

  const hitSl  = side === "buy" ? currentPrice <= slPrice  : currentPrice >= slPrice;
  const hitTp1 = !halfClosed && tp1 && (side === "buy" ? currentPrice >= tp1 : currentPrice <= tp1);
  const hitTp2 = halfClosed  && tp2 && (side === "buy" ? currentPrice >= tp2 : currentPrice <= tp2);
  // Fallback: old state with only tpPrice and no tp2
  const hitTpFull = !tp1Price && !halfClosed && state.tpPrice &&
    (side === "buy" ? currentPrice >= state.tpPrice : currentPrice <= state.tpPrice);

  if (hitSl) {
    console.log(`  🔴 SL atingido @ $${currentPrice.toFixed(2)} (SL=$${slPrice}) — a fechar posição...`);
    try {
      await closePosition(symbol, side, `SL @ $${slPrice}`);
      addDailyPnl(entryPrice, currentPrice, side, tradeSize, leverage, 1);
      recordSlHit(symbol); // start cooldown — no new entry for COOLDOWN_AFTER_SL_MS
      const cooldownMin = Math.round(CONFIG.cooldownAfterSlMs / 60000);
      const pnl = getDailyClosedPnl();
      await sendTelegram(
        `🔴 <b>Stop-Loss</b> — ${symbol}\n` +
        `Entrada: $${entryPrice} | SL: $${slPrice}\n` +
        `Preço atual: $${currentPrice.toFixed(2)}\n` +
        `⏸ Cooldown: ${cooldownMin}min sem novas entradas\n` +
        `📊 PnL hoje: $${pnl.toFixed(2)}`
      );
    } catch (e) {
      console.log(`  ❌ Erro a fechar por SL: ${e.message}`);
    }
    return;
  }

  if (hitTp1) {
    console.log(`  🎯 TP1 atingido @ $${currentPrice.toFixed(2)} (TP1=$${tp1}) — a fechar metade...`);
    try {
      const result = await closeHalfPosition(symbol, side);
      if (!result) return;
      // Move SL to break-even and mark half closed
      state.halfClosed   = true;
      state.breakEvenSet = true;
      state.slPrice      = entryPrice;
      savePositionState(state);
      console.log(`  ✅ Metade fechada | SL movido para break-even @ $${entryPrice}`);
      addDailyPnl(entryPrice, currentPrice, side, tradeSize, leverage, 0.5);
      const pnl = getDailyClosedPnl();
      await sendTelegram(
        `🎯 <b>TP1 atingido</b> — ${symbol}\n` +
        `Fechou metade (qty=${result.closedQty}) @ $${currentPrice.toFixed(2)}\n` +
        `SL movido para break-even @ $${entryPrice}\n` +
        `Aguarda TP2 @ $${tp2}\n` +
        `📊 PnL hoje: $${pnl.toFixed(2)}`
      );
    } catch (e) {
      console.log(`  ❌ Erro no TP1: ${e.message}`);
    }
    return;
  }

  if (hitTp2 || hitTpFull) {
    const tpHit = hitTp2 ? tp2 : state.tpPrice;
    console.log(`  🟢 TP2 atingido @ $${currentPrice.toFixed(2)} (TP2=$${tpHit}) — a fechar posição restante...`);
    try {
      await closePosition(symbol, side, `TP2 @ $${tpHit}`);
      addDailyPnl(entryPrice, currentPrice, side, tradeSize, leverage, 0.5);
      const pnl = getDailyClosedPnl();
      await sendTelegram(
        `🟢 <b>TP2 atingido</b> — ${symbol}\n` +
        `Entrada: $${entryPrice} | TP2: $${tpHit}\n` +
        `Preço atual: $${currentPrice.toFixed(2)}\n` +
        `📊 PnL hoje: $${pnl.toFixed(2)}`
      );
    } catch (e) {
      console.log(`  ❌ Erro no TP2: ${e.message}`);
    }
    return;
  }

  // Neither hit — log current distances
  const slDist  = side === "buy" ? currentPrice - slPrice : slPrice - currentPrice;
  const tp1Dist = tp1 && !halfClosed ? (side === "buy" ? tp1 - currentPrice : currentPrice - tp1) : null;
  const tp2Dist = tp2 && halfClosed  ? (side === "buy" ? tp2 - currentPrice : currentPrice - tp2) : null;
  const tpLabel = halfClosed ? `dist TP2: $${tp2Dist?.toFixed(2)}` : `dist TP1: $${tp1Dist?.toFixed(2)}`;
  console.log(`  📊 Posição ${side} @ $${entryPrice}${halfClosed ? " [metade aberta]" : ""} | dist SL: $${slDist.toFixed(2)} | ${tpLabel}`);
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

  // Fetch candle data — 15m for entry indicators, 1H for trend filter, BTC for correlation
  console.log("\n── Fetching market data ─────────────────────────────────\n");
  const [candles, candles1h, btcTrend] = await Promise.all([
    fetchCandles(CONFIG.symbol, "15m", 500),
    fetchCandles(CONFIG.symbol, "1h",  200),
    fetchBtcTrend(),
  ]);
  const closes   = candles.map((c) => c.close);
  const closes1h = candles1h.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8     = calcEMA(closes, 8);
  const vwap     = calcVWAP(candles);
  const rsi3Raw  = calcRSI(closes, 3);
  const rsi14_15m = calcRSI(closes, 14);   // 15m RSI(14) — fallback for extreme RSI(3)
  const ema50_1h = calcEMA(closes1h, 50);

  const atrData  = calcATR(candles, 14);
  const rsi14_1h = calcRSI(closes1h, 14);
  const volAvg   = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  const lastVol  = candles[candles.length - 1].volume;
  const volLow   = lastVol < volAvg;

  // Cross-validate RSI(3) extreme values against candle closes
  let rsi3 = rsi3Raw;
  let rsi3Substituted = false;
  if (rsi3Raw !== null && !isNaN(rsi3Raw) && (rsi3Raw === 0 || rsi3Raw === 100)) {
    const { valid, reason } = validateRsi3(rsi3Raw, closes);
    if (!valid) {
      console.log(`  ⚠️  RSI(3) cross-validation: ${reason}`);
      rsi3 = rsi14_15m;   // substitute with RSI(14) on same timeframe
      rsi3Substituted = true;
    } else {
      console.log(`  ✅ RSI(3)=${rsi3Raw.toFixed(0)} confirmado pelos últimos 3 candles`);
    }
  }

  const rsi3Valid    = rsi3 !== null && !isNaN(rsi3);
  const rsi14_1hValid = rsi14_1h !== null && !isNaN(rsi14_1h);
  console.log(`  EMA(8)  15m: $${ema8 != null ? ema8.toFixed(2) : "N/A"}`);
  console.log(`  VWAP    15m: $${vwap != null ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3)  15m: ${rsi3Valid ? rsi3.toFixed(2) : "N/A"}${rsi3Substituted ? " (substituído por RSI(14) 15m)" : rsi3Raw !== null && (rsi3Raw === 0 || rsi3Raw === 100) ? " ⚠️ extremo" : ""}`);
  console.log(`  RSI(14) 1H:  ${rsi14_1hValid ? rsi14_1h.toFixed(2) : "N/A"} (1H RSI filter)`);
  console.log(`  EMA(50) 1H:  $${ema50_1h != null ? ema50_1h.toFixed(2) : "N/A"} (trend filter)`);
  const effectiveLeverage = atrData ? calcEffectiveLeverage(atrData.atr, atrData.avg50) : parseInt(process.env.LEVERAGE || "60");
  console.log(`  ATR(14) 15m: ${atrData ? `$${atrData.atr.toFixed(2)} — ${atrData.volatile ? "✅ volatile" : "🚫 choppy"}` : "N/A"}`);
  console.log(`  Leverage:    ${effectiveLeverage}x (dinâmica — base: ${process.env.LEVERAGE || "60"}x)`);
  console.log(`  BTC trend:   ${btcTrend ?? "N/A (par BTC ou erro)"}`);
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
    return;
  }

  // ── SL/TP monitoring — runs every cycle before any new trade logic ──────
  console.log("\n── SL/TP & Break-even check ─────────────────────────────\n");
  await checkSlTp(CONFIG.symbol, price);
  await checkBreakEven(CONFIG.symbol, price, atrData.atr);
  await checkTrailingStop(CONFIG.symbol, price, atrData.atr);

  if (!atrData.volatile) {
    console.log("\n🚫 Market is choppy (ATR below average) — no trade.");
    logSkip(price, "Choppy market (ATR below average)");
    return;
  }

  if (!volLow) {
    console.log("\n🚫 Volume above average — pullback is strong, not a snap-back setup.");
    logSkip(price, "Volume above average — strong pullback");
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

  // Calculate position size — risk-based if RISK_PER_TRADE_USD is set, otherwise fixed
  const tradeSize = CONFIG.riskPerTradeUSD > 0
    ? calcRiskBasedTradeSize(CONFIG.riskPerTradeUSD, price, atrData.atr, effectiveLeverage, CONFIG.maxTradeSizeUSD)
    : CONFIG.maxTradeSizeUSD;
  const tradeSizeMode = CONFIG.riskPerTradeUSD > 0
    ? `risk-based ($${CONFIG.riskPerTradeUSD} risco → $${tradeSize} margem)`
    : `fixo ($${tradeSize})`;
  console.log(`  Trade size: $${tradeSize} — ${tradeSizeMode}`);

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
  if (btcTrend) {
    const btcAligned = (h1Side === "buy" && btcTrend === "bullish") || (h1Side === "sell" && btcTrend === "bearish");
    if (!btcAligned) results.push({ label: `BTC trend (${btcTrend}) oposto ao sinal (${h1Side})`, pass: false });
  }
  logEntry.conditions = results;
  logEntry.allPass    = results.every(r => r.pass);

  if (!logEntry.allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    // Check cooldown — do not re-enter immediately after a SL on the same symbol
    const cooldown = checkCooldown(CONFIG.symbol);
    if (cooldown.blocked) {
      const remainingMin = Math.ceil(cooldown.remainingSec / 60);
      console.log(`⏸ COOLDOWN ATIVO — ${remainingMin}min restantes após último SL. A aguardar...`);
      logSkip(price, `Cooldown após SL (${remainingMin}min restantes)`);
      return;
    }

    const direction = tradeSide === "buy" ? "LONG" : "SHORT";
    const atr = atrData.atr;
    const stopPrice = tradeSide === "buy"
      ? (price - atr * 1.5).toFixed(2)
      : (price + atr * 1.5).toFixed(2);
    const tp1Price = tradeSide === "buy"
      ? (price + atr * 3).toFixed(2)
      : (price - atr * 3).toFixed(2);
    const tp2Price = tradeSide === "buy"
      ? (price + atr * 5).toFixed(2)
      : (price - atr * 5).toFixed(2);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — ${direction} ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   SL: $${stopPrice} (1.5×ATR) | TP1: $${tp1Price} (3×ATR) | TP2: $${tp2Price} (5×ATR)`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      logEntry.side = tradeSide;
      logEntry.stopLoss = stopPrice;
      logEntry.takeProfit = tp2Price;
      const pnlPaper = getDailyClosedPnl();
      await sendTelegram(`📋 <b>Bot v1 ${CONFIG.symbol}</b> — PAPER ${direction}\nPreço: $${price.toFixed(2)} | Size: $${tradeSize.toFixed(2)}\nSL: $${stopPrice} | TP1: $${tp1Price} (3×ATR) | TP2: $${tp2Price} (5×ATR)\n📊 PnL hoje: $${pnlPaper.toFixed(2)}`);
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — ${direction} $${tradeSize.toFixed(2)} ${CONFIG.symbol}`,
      );
      try {
        if (CONFIG.tradeMode === "futures") {
          const openPos = await getOpenPosition(CONFIG.symbol);
          if (openPos) {
            const currentState  = loadPositionState();
            const openSide      = openPos.side.toLowerCase(); // "buy" or "sell"
            const isReentry     = currentState?.halfClosed && openSide === tradeSide;
            const isOpposite    = openSide !== tradeSide;

            if (isReentry) {
              // Re-entry after TP1 — position is same direction and half-closed
              console.log(`🔁 Re-entrada após TP1 — posição ${tradeSide} já tem metade aberta, a adicionar...`);

            } else if (isOpposite) {
              // Opposite position open — conditional reversal
              const pnl        = openPos.unrealizedPnl; // null = field not found in MEXC response
              const pnlKnown   = pnl !== null && !isNaN(pnl);
              // If PnL is unknown (field not mapped), treat conservatively as a large loss → block
              const lossOk     = pnlKnown && pnl >= -CONFIG.maxReversalLossUSD;
              const pnlDisplay = pnlKnown ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "desconhecido";

              console.log(`  🔄 Posição oposta detectada: ${openPos.side} qty=${openPos.size} | PnL não realizado: ${pnlDisplay}`);

              if (lossOk) {
                console.log(`  ✅ Perda ($${pnl.toFixed(2)}) dentro do limite (-$${CONFIG.maxReversalLossUSD}) — a fechar e reverter para ${tradeSide.toUpperCase()}...`);
                await closePosition(CONFIG.symbol, openSide, `Reversão → ${tradeSide}`);
                // Proceed — placeMexcOrder will open the new position below
              } else {
                const reason = pnlKnown
                  ? `PnL $${pnl.toFixed(2)} (limite: -$${CONFIG.maxReversalLossUSD})`
                  : `PnL desconhecido — campo não mapeado na resposta MEXC (ver log [debug])`;
                const msg = `⏸ Reversão bloqueada — ${openPos.side} tem ${reason}\nA aguardar redução do risco antes de reverter`;
                console.log(`  ${msg}`);
                await sendTelegram(`⏸ <b>Bot v1 ${CONFIG.symbol}</b> — Sinal ${tradeSide.toUpperCase()} válido\n${msg}`);
                logEntry.error = `Reversal blocked: ${reason}`;
                throw new Error(`Reversal blocked — ${reason}`);
              }

            } else {
              // Same direction, not a re-entry — duplicate signal, skip
              console.log(`⚠️  Posição já aberta (${openPos.side} qty=${openPos.size}) — a saltar nova ordem.`);
              logEntry.error = `Position already open: ${openPos.side} qty=${openPos.size}`;
              throw new Error(`Position already open: ${openPos.side} qty=${openPos.size}`);
            }
          }
        }
        console.log(`  Leverage efetivo: ${effectiveLeverage}x | SL: $${stopPrice} (1.5×ATR) | TP1: $${tp1Price} (3×ATR) | TP2: $${tp2Price} (5×ATR)`);
        const order = await placeMexcOrder(CONFIG.symbol, tradeSide, tradeSize, price, stopPrice, tp1Price, tp2Price, effectiveLeverage);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        logEntry.side = tradeSide;
        logEntry.stopLoss = stopPrice;
        logEntry.takeProfit = tp2Price;
        console.log(`✅ ORDER PLACED — ${order.orderId} | SL: $${stopPrice} | TP1: $${tp1Price} | TP2: $${tp2Price}`);
        const pnlLive = getDailyClosedPnl();
        await sendTelegram(`✅ <b>Bot v1 ${CONFIG.symbol}</b> — LIVE ${direction}\nPreço: $${price.toFixed(2)} | Size: $${tradeSize.toFixed(2)} | Lev: ${effectiveLeverage}x\nSL: $${stopPrice} (1.5×ATR) | TP1: $${tp1Price} (3×ATR) | TP2: $${tp2Price} (5×ATR)\n📊 PnL hoje: $${pnlLive.toFixed(2)}`);
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
