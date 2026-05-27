import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";

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
  // Stable coins (e.g. BTC, SOL, ETH): wider trailing to avoid early stop-outs.
  // STABLE_SYMBOLS = comma-separated list of symbols (e.g. BTCUSDT,SOLUSDT,ETHUSDT)
  // Leave empty to disable the feature (all symbols use the defaults above).
  stableSymbols:              (process.env.STABLE_SYMBOLS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
  stableTrailingStopPct:      parseFloat(process.env.STABLE_TRAILING_STOP_PCT       || "0.05"),
  stableTrailingActivationPct: parseFloat(process.env.STABLE_TRAILING_ACTIVATION_PCT || "0.01"),
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
  // Trend filter: block signals that go considerably against the higher-timeframe trend (0 = disabled)
  trendInterval:    process.env.TREND_INTERVAL              || "60",  // higher TF for trend (minutes)
  trendEmaPeriod:   parseInt(process.env.TREND_EMA_PERIOD   || "50"),
  trendMarginPct:   parseFloat(process.env.TREND_MARGIN_PCT || "0"),  // 0.01 = block if >1% wrong side
  // Chase Limit: try limit order at bid/ask (maker fee 0.02%) before falling back to market (taker 0.055%)
  chaseLimitEnabled:    process.env.CHASE_LIMIT             !== "false",  // true by default
  chaseLimitTimeoutMs:  parseInt(process.env.CHASE_LIMIT_TIMEOUT_MS || "3000"),
  // Break-even SL buffer: on TP1, SL moves to entry ± (ATR × this multiplier) instead of exact entry.
  // Prevents SL from triggering on micro-retracements right after TP1. Set to 0 to disable.
  breakEvenBufferAtr:   parseFloat(process.env.BREAK_EVEN_BUFFER_ATR || "0.3"),
  // Fee viability filter: skip trade if expected TP1 profit < round-trip fees × this threshold (0 = disabled)
  feeViabilityThreshold: parseFloat(process.env.FEE_VIABILITY_THRESHOLD || "1.5"),
  // Cooldown after inferred SL: block same-symbol same-direction re-entry for this many ms (0 = disabled)
  cooldownAfterSlMs:    parseInt(process.env.COOLDOWN_AFTER_SL_MS || "900000"),  // default 15 min
  // Max SL hits per symbol per day before blocking all new entries for that symbol (0 = disabled)
  maxSlPerSymbol:       parseInt(process.env.MAX_SL_PER_SYMBOL || "0"),
  // Minimum Risk:Reward ratio filter (0 = disabled).
  // Since TP is fired by TradingView (not placed on Bybit), the TP reference is computed
  // dynamically as SL × minRR (the minimum move TradingView's strategy should target).
  // The filter only blocks if MAX_TP_PCT is set and the implied TP target exceeds it
  // (i.e., the required move is unrealistically large for the current volatility).
  // Example: minRR=1.35, SL=3.79% → implied TP target = 5.12%; blocked only if MAX_TP_PCT < 5.12%
  minRR:                parseFloat(process.env.MIN_RR     || "0"),
  // Maximum implied TP % cap for the dynamic R:R filter (0 = no cap / always pass).
  // Block trade if SL×minRR would require a move larger than this to reach minRR.
  // Example: MAX_TP_PCT=0.12 → block if implied TP > 12% (unrealistically large target)
  maxTpPct:             parseFloat(process.env.MAX_TP_PCT || "0"),
  // TP loss guard: skip TP close if the position's unrealized PnL is below this threshold (USD).
  // Prevents closing half the position at a loss when TradingView's TP fires at a price that is
  // still below the bot's actual entry (e.g. due to slippage or a different entry price).
  // 0 = always execute TP regardless of current PnL (default — no protection).
  // Example: MIN_TP_PNL_USD=-1 → allow TP only if unrealized PnL ≥ -$1 (tiny loss accepted).
  //          MIN_TP_PNL_USD=0  → only execute TP if position is at or above break-even.
  minTpPnlUSD:          parseFloat(process.env.MIN_TP_PNL_USD || "0"),
  // Reversal loss guard: block closing an opposite position if its unrealized loss
  // exceeds this threshold in USD. 0 = always reverse (no protection).
  // Example: MAX_REVERSAL_LOSS_USD=5 → only reverse if open position loss ≤ $5
  maxReversalLossUSD:   parseFloat(process.env.MAX_REVERSAL_LOSS_USD || "0"),
  // Dynamic leverage: reduce leverage when ATR is elevated vs its 50-bar average.
  //   ATR ≤ avg        → full leverage
  //   ATR 1.0–1.5× avg → 75% of base leverage
  //   ATR > 1.5× avg   → 50% of base leverage
  // Set DYNAMIC_LEVERAGE=true to enable.
  dynamicLeverage:      process.env.DYNAMIC_LEVERAGE === "true",
  // Time filter: only process buy/sell signals within this UTC hour window (inclusive start, exclusive end).
  // Example: TRADE_HOURS_START=8 TRADE_HOURS_END=22 → only trade 08:00–21:59 UTC
  // Supports overnight: TRADE_HOURS_START=22 TRADE_HOURS_END=6 → 22:00–05:59 UTC
  // Leave both unset (default) to trade 24/7.
  tradeHoursStart: process.env.TRADE_HOURS_START != null ? parseInt(process.env.TRADE_HOURS_START) : null,
  tradeHoursEnd:   process.env.TRADE_HOURS_END   != null ? parseInt(process.env.TRADE_HOURS_END)   : null,
  // Volume filter: skip entry if current bar volume < VOLUME_FILTER_MULT × avg of last N bars.
  // Example: VOLUME_FILTER_MULT=0.5 → skip if volume is below 50% of its 20-bar average.
  // 0 = disabled.
  volumeFilterMult:     parseFloat(process.env.VOLUME_FILTER_MULT    || "0"),
  volumeFilterPeriods:  parseInt(process.env.VOLUME_FILTER_PERIODS   || "20"),
  // Position timeout: close stagnant positions that have been open longer than X hours
  // AND whose unrealized PnL is between PNL_MIN and PNL_MAX (default: -$1 to +$1).
  // 0 = disabled. Checked every 5 minutes in the background.
  positionTimeoutHours:  parseFloat(process.env.POSITION_TIMEOUT_HOURS   || "0"),
  positionTimeoutPnlMin: parseFloat(process.env.POSITION_TIMEOUT_PNL_MIN || "-1"),
  positionTimeoutPnlMax: parseFloat(process.env.POSITION_TIMEOUT_PNL_MAX || "1"),
  // Spread check: skip entry if bid/ask spread exceeds this % of mid price (0 = disabled).
  // Example: MAX_SPREAD_PCT=0.1 → skip if spread > 0.1% (i.e. 10 bps)
  maxSpreadPct: parseFloat(process.env.MAX_SPREAD_PCT || "0"),
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

// ─── Symbol State (cooldown + SL tracking) ───────────────────────────────────
// Tracks per-symbol: last buy/sell signal time, last TP time, daily SL count.
// Persisted to disk so Railway restarts don't reset the state.

const SYMBOL_STATE_FILE = "symbol-state.json";
let symbolState = {};

function loadSymbolState() {
  try {
    if (existsSync(SYMBOL_STATE_FILE))
      symbolState = JSON.parse(readFileSync(SYMBOL_STATE_FILE, "utf8"));
  } catch { symbolState = {}; }
}

function saveSymbolState() {
  try { writeFileSync(SYMBOL_STATE_FILE, JSON.stringify(symbolState, null, 2)); } catch {}
}

function _getSymState(symbol) {
  if (!symbolState[symbol]) symbolState[symbol] = {};
  return symbolState[symbol];
}

function _todayUTC() { return new Date().toISOString().slice(0, 10); }

// Called after a BUY/SELL order is successfully placed.
function recordSignalPlaced(symbol, action) {
  const s = _getSymState(symbol);
  if (action === "buy") s.lastBuyTime = Date.now();
  else                  s.lastSellTime = Date.now();
  s.positionOpenTime = Date.now(); // for position timeout tracking
  saveSymbolState();
}

// Called when a TP signal is processed (position closed naturally, not by SL).
function recordTpReceived(symbol) {
  const s = _getSymState(symbol);
  s.lastTpTime      = Date.now();
  s.positionOpenTime = null; // position closed — stop timeout tracking
  saveSymbolState();
}

// Check if a new entry should be blocked due to cooldown or daily SL limit.
// Logic:
//   SL inferred when: no open position + recently placed same-dir signal + no TP received after it.
//   If SL inferred → increment daily counter → check cooldown and daily limit.
// Returns { blocked, reason } — side-effect: persists SL count if SL is inferred.
function checkCooldownAndSlLimit(symbol, action, hasOpenPosition) {
  const s     = _getSymState(symbol);
  const today = _todayUTC();
  const now   = Date.now();

  // Reset daily counter on new UTC day
  if (s.slDate !== today) { s.slCountToday = 0; s.slDate = today; }

  const lastSameDir = action === "buy" ? s.lastBuyTime : s.lastSellTime;
  if (!lastSameDir) return { blocked: false }; // no previous signal → nothing to infer

  const elapsed       = now - lastSameDir;
  const tpAfterSignal = s.lastTpTime && s.lastTpTime > lastSameDir;

  // SL inferred: no open position + same-dir signal within 24h + no TP received after it
  const slInferred = !hasOpenPosition && elapsed < 24 * 60 * 60 * 1000 && !tpAfterSignal;
  if (!slInferred) return { blocked: false };

  // Increment SL counter
  s.slCountToday = (s.slCountToday || 0) + 1;
  saveSymbolState();
  console.log(`  📊 SL inferido em ${symbol} (${action}) — ${s.slCountToday}× hoje`);

  // Check daily SL limit
  if (CONFIG.maxSlPerSymbol > 0 && s.slCountToday >= CONFIG.maxSlPerSymbol) {
    return {
      blocked: true,
      reason: `🛑 ${symbol} bloqueado — ${s.slCountToday} SL hoje (limite: ${CONFIG.maxSlPerSymbol}/dia)`,
    };
  }

  // Check cooldown
  if (CONFIG.cooldownAfterSlMs > 0 && elapsed < CONFIG.cooldownAfterSlMs) {
    const remainingMin = Math.ceil((CONFIG.cooldownAfterSlMs - elapsed) / 60000);
    return {
      blocked: true,
      reason: `⏸ Cooldown após SL em ${symbol} (${action}) — aguarda ${remainingMin}min`,
    };
  }

  return { blocked: false }; // SL inferred but cooldown already passed — allow entry
}

// ─── Telegram Notifications ──────────────────────────────────────────────────

async function sendTelegram(message, chatId = null) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const target = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !target) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: target, text: message, parse_mode: "HTML" }),
  }).catch((e) => console.log("Telegram error:", e.message));
}

// ─── Telegram Command Polling ─────────────────────────────────────────────────
// Polls getUpdates in a loop so the bot can respond to commands sent in the chat.
// Supported commands:
//   /pnl2  — daily closed PnL (total + per symbol)
//   /pos2  — open positions summary

async function handleTelegramCommand(text, chatId) {
  const cmd = (text || "").trim().split(/\s+/)[0].toLowerCase().replace(/@\S+/, "");

  if (cmd === "/pnl2") {
    try {
      // Fetch all closed trades today (no symbol filter) and group by symbol
      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);
      const startTime  = todayMidnight.getTime().toString();
      const timestamp  = (Date.now() - 1500).toString();
      const recvWindow = "10000";
      const params     = `category=linear&startTime=${startTime}&limit=200`;
      const sig        = sign(timestamp, recvWindow, params);
      const res  = await fetch(`${CONFIG.bybit.baseUrl}/v5/position/closed-pnl?${params}`, {
        headers: { "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
      });
      const data = await res.json();
      const list = data.result?.list || [];

      // Group by symbol
      const bySymbol = {};
      let total = 0;
      for (const item of list) {
        const sym = item.symbol;
        const pnl = parseFloat(item.closedPnl || 0);
        bySymbol[sym] = (bySymbol[sym] || 0) + pnl;
        total += pnl;
      }

      const todayStr = new Date().toISOString().slice(0, 10);
      const lines = Object.entries(bySymbol)
        .sort((a, b) => b[1] - a[1])
        .map(([sym, pnl]) => `  ${sym}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);

      const emoji = total >= 0 ? "🟢" : "🔴";
      const msg = [
        `${emoji} <b>PnL do dia — Bot v2</b> (${todayStr})`,
        `<b>Total: ${total >= 0 ? "+" : ""}$${total.toFixed(2)}</b>`,
        lines.length > 0 ? "\nPor símbolo:\n" + lines.join("\n") : "\nNenhuma trade fechada hoje.",
      ].join("\n");

      await sendTelegram(msg, chatId);
    } catch (e) {
      await sendTelegram(`❌ Erro ao obter PnL: ${e.message}`, chatId);
    }
    return;
  }

  if (cmd === "/pos2") {
    try {
      const timestamp  = (Date.now() - 1500).toString();
      const recvWindow = "10000";
      const params     = "category=linear&settleCoin=USDT";
      const sig        = sign(timestamp, recvWindow, params);
      const res  = await fetch(`${CONFIG.bybit.baseUrl}/v5/position/list?${params}`, {
        headers: { "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
      });
      const data = await res.json();
      const positions = (data.result?.list || []).filter(p => parseFloat(p.size) > 0);

      if (positions.length === 0) {
        await sendTelegram(`📭 <b>Bot v2</b> — Sem posições abertas`, chatId);
        return;
      }

      const lines = positions.map(p => {
        const pnl    = parseFloat(p.unrealisedPnl || 0);
        const emoji  = pnl >= 0 ? "🟢" : "🔴";
        return `${emoji} <b>${p.symbol}</b> ${p.side} | qty=${p.size} | entry=$${parseFloat(p.avgPrice).toFixed(4)}\n   PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | SL=$${p.stopLoss || "—"}`;
      });

      await sendTelegram(`📊 <b>Posições abertas — Bot v2</b>\n\n${lines.join("\n\n")}`, chatId);
    } catch (e) {
      await sendTelegram(`❌ Erro ao obter posições: ${e.message}`, chatId);
    }
    return;
  }
}

async function startTelegramPolling() {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("⚠️  Telegram polling desativado — TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID em falta");
    return;
  }

  let offset = 0;
  console.log("📡 Telegram polling ativo — comandos disponíveis: /pnl2, /pos2");

  const poll = async () => {
    try {
      const res  = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}&allowed_updates=["message"]`, { signal: AbortSignal.timeout(30000) });
      const data = await res.json();
      if (!data.ok) return;

      for (const update of data.result || []) {
        offset = update.update_id + 1;
        const msg     = update.message;
        const text    = msg?.text || "";
        const fromId  = String(msg?.chat?.id || "");

        // Only respond to messages from the configured chat
        if (fromId !== String(chatId)) continue;
        if (!text.startsWith("/")) continue;

        console.log(`[Telegram cmd] ${text.trim()}`);
        await handleTelegramCommand(text, fromId);
      }
    } catch (_) {
      // Network blip — silently retry
    }
    setTimeout(poll, 1000);
  };

  poll();
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

// Bybit supports these kline intervals (minutes, or D/W/M).
// TradingView may send unsupported values (e.g. "2") — map to nearest supported.
const BYBIT_INTERVALS = [1, 3, 5, 15, 30, 60, 120, 240, 360, 720];

function toBybitInterval(tvInterval) {
  const str = String(tvInterval || "").toUpperCase();
  if (["D", "W", "M"].includes(str)) return str;
  const num = parseInt(str);
  if (isNaN(num)) return CONFIG.candleInterval; // fallback to config default
  if (BYBIT_INTERVALS.includes(num)) return String(num);
  // Map to nearest supported numeric interval
  const nearest = BYBIT_INTERVALS.reduce((a, b) =>
    Math.abs(b - num) < Math.abs(a - num) ? b : a
  );
  console.log(`  ⚠️  Intervalo ${num}m não suportado pela Bybit — a usar ${nearest}m`);
  return String(nearest);
}

// Fetch current best bid and ask prices for a symbol.
async function fetchBidAsk(symbol) {
  const res  = await fetch(`${CONFIG.bybit.baseUrl}/v5/market/tickers?category=linear&symbol=${symbol}`);
  const data = await res.json();
  const t    = data.result?.list?.[0];
  if (!t) throw new Error(`fetchBidAsk: sem dados de ticker para ${symbol}`);
  return { bid: parseFloat(t.bid1Price), ask: parseFloat(t.ask1Price) };
}

// Query the status of an open/recent order.
// Returns orderStatus string (e.g. "New", "Filled", "PartiallyFilled", "Cancelled") or null on error.
async function getOrderStatus(symbol, orderId) {
  const timestamp  = (Date.now() - 1500).toString();
  const recvWindow = "10000";
  const params     = `category=linear&symbol=${symbol}&orderId=${orderId}`;
  const sig        = sign(timestamp, recvWindow, params);
  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/realtime?${params}`, {
    headers: { "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
  });
  const data = await res.json();
  return data.result?.list?.[0]?.orderStatus ?? null;
}

// Cancel an open order by orderId.
async function cancelOrder(symbol, orderId) {
  const timestamp  = (Date.now() - 1500).toString();
  const recvWindow = "10000";
  const body       = JSON.stringify({ category: "linear", symbol, orderId });
  const sig        = sign(timestamp, recvWindow, body);
  const res = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0) console.log(`  ⚠️  Cancelamento de ordem falhou: ${data.retMsg}`);
  return data;
}

// Fetch candles from Bybit and compute simple ATR(period).
// interval: Bybit-compatible interval string — derived from TradingView payload or CANDLE_INTERVAL.
// If TradingView already sends "atr" in the payload, this function is skipped entirely.
async function fetchATR(symbol, interval) {
  const limit = CONFIG.atrPeriod + 1; // need one extra candle for the first prev-close
  const res   = await fetch(
    `${CONFIG.bybit.baseUrl}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`
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

// Fetch higher-timeframe candles and compute EMA(period) for trend direction.
// Returns the EMA value; caller compares to current price to determine trend.
async function fetchTrendEMA(symbol, interval, period) {
  const limit = period * 2; // extra candles for EMA warm-up
  const res   = await fetch(
    `${CONFIG.bybit.baseUrl}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  const data    = await res.json();
  const candles = data.result?.list;
  if (!candles || candles.length < period)
    throw new Error(`Trend EMA: só ${candles?.length ?? 0} velas (precisa de ${period})`);

  // Bybit returns newest-first — reverse to oldest-first for sequential EMA
  const closes = candles.map(c => parseFloat(c[4])).reverse();
  const k      = 2 / (period + 1);
  let ema      = closes[0]; // seed with oldest close
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// Returns whether hourUTC falls within [start, end) — handles overnight windows.
function isInTimeWindow(hourUTC, start, end) {
  if (start === null || end === null) return true;
  if (start <= end) return hourUTC >= start && hourUTC < end;
  return hourUTC >= start || hourUTC < end; // overnight: e.g. 22→6
}

// Fetch the 50-bar simple average of True Range (used as baseline for dynamic leverage).
// Requires ATR_PERIOD + 50 + 1 candles.
async function fetchATRAvg50(symbol, interval) {
  const avgPeriod = 50;
  const limit     = CONFIG.atrPeriod + avgPeriod + 1;
  const res       = await fetch(`${CONFIG.bybit.baseUrl}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const data      = await res.json();
  const candles   = data.result?.list;
  if (!candles || candles.length < CONFIG.atrPeriod + 2)
    throw new Error(`ATRAvg50: só ${candles?.length ?? 0} velas`);
  // Bybit: newest-first. Compute TR for each consecutive pair.
  const trs = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const h = parseFloat(candles[i][2]), l = parseFloat(candles[i][3]), pc = parseFloat(candles[i + 1][4]);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Long-term baseline = avg of all available TRs (atrPeriod + avgPeriod bars)
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// Reduce leverage when ATR is elevated relative to its 50-bar baseline.
function calcDynamicLeverage(atr, avg50, baseLev) {
  const ratio = atr / avg50;
  if (ratio > 1.5) return Math.floor(baseLev * 0.5);
  if (ratio > 1.0) return Math.floor(baseLev * 0.75);
  return baseLev;
}

// Fetch best bid/ask from Bybit orderbook and return spread as % of mid price.
async function fetchSpreadPct(symbol) {
  const res  = await fetch(`${CONFIG.bybit.baseUrl}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=1`);
  const data = await res.json();
  const bid  = parseFloat(data.result?.b?.[0]?.[0]);
  const ask  = parseFloat(data.result?.a?.[0]?.[0]);
  if (!bid || !ask) throw new Error("Orderbook vazio");
  const mid = (bid + ask) / 2;
  return { bid, ask, spreadPct: (ask - bid) / mid };
}

// Returns { currentVol, avgVol, ratio } for volume filter.
// currentVol = volume of the most recent completed bar; avgVol = mean of last `periods` bars.
async function fetchVolumeRatio(symbol, interval, periods) {
  const limit   = periods + 1; // +1 so candles[0] (possibly open bar) is excluded
  const res     = await fetch(`${CONFIG.bybit.baseUrl}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const data    = await res.json();
  const candles = data.result?.list;
  if (!candles || candles.length < 2) throw new Error("Volume: candles insuficientes");
  // candles[0] = current (may be incomplete); candles[1..] = completed bars
  const completed  = candles.slice(1);
  const currentVol = parseFloat(completed[0][5]);
  const avgVol     = completed.reduce((s, c) => s + parseFloat(c[5]), 0) / completed.length;
  return { currentVol, avgVol, ratio: currentVol / avgVol };
}

// Background position timeout check — runs every 5 min when POSITION_TIMEOUT_HOURS > 0.
async function checkPositionTimeouts() {
  if (!CONFIG.positionTimeoutHours) return;
  const timeoutMs = CONFIG.positionTimeoutHours * 3_600_000;
  const now       = Date.now();
  for (const [sym, state] of Object.entries(symbolState)) {
    if (!state.positionOpenTime) continue;
    const elapsed = now - state.positionOpenTime;
    if (elapsed < timeoutMs) continue;
    try {
      const pos = await getOpenPosition(sym);
      if (!pos) { state.positionOpenTime = null; saveSymbolState(); continue; }
      const pnl = pos.unrealizedPnl;
      if (pnl >= CONFIG.positionTimeoutPnlMin && pnl <= CONFIG.positionTimeoutPnlMax) {
        const elapsedH = (elapsed / 3_600_000).toFixed(1);
        console.log(`\n⏰ Timeout — ${sym} aberto há ${elapsedH}h | PnL: $${pnl.toFixed(2)} — a fechar`);
        const result = await closePosition(sym, pos);
        console.log(`  ✅ Fechado por timeout — ${result.orderId}`);
        state.positionOpenTime = null;
        saveSymbolState();
        await sendTelegram(
          `⏰ <b>Bot v2 ${sym}</b> — Posição fechada por timeout\n` +
          `Aberta há ${elapsedH}h | PnL: $${pnl.toFixed(2)}\n` +
          `(PnL dentro de $${CONFIG.positionTimeoutPnlMin} a $${CONFIG.positionTimeoutPnlMax})`
        );
      }
    } catch (e) {
      console.log(`  ⚠️  Timeout check ${sym}: ${e.message}`);
    }
  }
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
// Returns { orderId, slPrice, slPct, slDistance, atrUsed, tradeSize, filledAs }
//   filledAs: "maker" (limit filled) | "taker" (market fallback)
async function placeOrder(symbol, action, price, lev, atrValue = null) {
  const side = action === "buy" ? "Buy" : "Sell";

  // ── ATR-based SL ─────────────────────────────────────────────────────────
  let atr = atrValue;
  if (!atr) {
    try {
      atr = await fetchATR(symbol, CONFIG.candleInterval);
    } catch (e) {
      console.log(`  ⚠️  ATR fetch falhou (${e.message}) — a usar SL fixo ${CONFIG.stopLossPct * 100}%`);
    }
  }

  let slPct, slDistance;
  if (atr) {
    slDistance = atr * CONFIG.atrMultiplier;
    slPct      = slDistance / price;
    // Note: interval label omitted here — already logged in handleWebhook when ATR was resolved
    console.log(`  ATR=$${atr.toFixed(4)} | SL=${CONFIG.atrMultiplier}×ATR=$${slDistance.toFixed(4)} (${(slPct * 100).toFixed(3)}%)`);
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

  // ── Chase Limit → Market fallback ────────────────────────────────────────
  // 1st attempt: Limit order at current bid (buy) or ask (sell) → maker fee 0.02%
  // If not filled within CHASE_LIMIT_TIMEOUT_MS → cancel → Market order → taker fee 0.055%
  let orderId  = null;
  let filledAs = "taker";

  if (CONFIG.chaseLimitEnabled && CONFIG.tradeMode === "futures") {
    try {
      const { bid, ask } = await fetchBidAsk(symbol);
      const limitPrice   = (action === "buy" ? bid : ask).toFixed(2);
      console.log(`  🎯 Chase Limit @ $${limitPrice} (${action === "buy" ? "bid" : "ask"}) — aguarda ${CONFIG.chaseLimitTimeoutMs}ms`);

      const limitBody = JSON.stringify({
        category: "linear", symbol, side,
        orderType: "Limit",
        price: limitPrice,
        qty: quantity,
        timeInForce: "GTC",
        stopLoss, slTriggerBy: "LastPrice",
        positionIdx: 0,
      });
      const ts1  = (Date.now() - 1500).toString();
      const rw1  = "10000";
      const sig1 = sign(ts1, rw1, limitBody);
      const res1 = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig1, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": ts1, "X-BAPI-RECV-WINDOW": rw1 },
        body: limitBody,
      });
      const d1 = await res1.json();

      if (d1.retCode === 0) {
        const limitOrderId = d1.result?.orderId;
        // Wait for potential fill
        await new Promise(r => setTimeout(r, CONFIG.chaseLimitTimeoutMs));
        const status = await getOrderStatus(symbol, limitOrderId);
        console.log(`  Status após ${CONFIG.chaseLimitTimeoutMs}ms: ${status ?? "desconhecido"}`);

        if (status === "Filled") {
          orderId  = limitOrderId;
          filledAs = "maker";
          console.log(`  ✅ LIMIT FILLED — taxa maker 0.02%`);
        } else if (status === "PartiallyFilled") {
          // Accept partial fill, cancel remaining to avoid open limit sitting in book
          await cancelOrder(symbol, limitOrderId);
          orderId  = limitOrderId;
          filledAs = "maker";
          console.log(`  ✅ LIMIT PARCIALMENTE FILLED — restante cancelado | taxa maker 0.02%`);
        } else {
          // Not filled → cancel and fall through to market
          console.log(`  ⚠️  Limit não encheu (${status ?? "unknown"}) — a cancelar → Market`);
          await cancelOrder(symbol, limitOrderId);
        }
      } else {
        console.log(`  ⚠️  Limit rejeitada pela Bybit (${d1.retMsg}) — a usar Market`);
      }
    } catch (e) {
      console.log(`  ⚠️  Chase Limit erro (${e.message}) — a usar Market`);
    }
  }

  // ── Market order (fallback ou direto se chase limit desativado) ───────────
  if (!orderId) {
    const marketBody = JSON.stringify(
      CONFIG.tradeMode === "futures"
        ? { category: "linear", symbol, side, orderType: "Market", qty: quantity, positionIdx: 0,
            stopLoss, slTriggerBy: "LastPrice" }
        : { category: "spot", symbol, side, orderType: "Market", qty: quantity }
    );
    const ts2  = (Date.now() - 1500).toString();
    const rw2  = "10000";
    const sig2 = sign(ts2, rw2, marketBody);
    const res2 = await fetch(`${CONFIG.bybit.baseUrl}/v5/order/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig2, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": ts2, "X-BAPI-RECV-WINDOW": rw2 },
      body: marketBody,
    });
    const d2 = await res2.json();
    if (d2.retCode !== 0) throw new Error(`Order failed: ${d2.retMsg}`);
    orderId  = d2.result?.orderId;
    filledAs = "taker";
    console.log(`  ✅ MARKET ORDER — taxa taker 0.055%`);
  }

  return { orderId, slPrice: stopLoss, slPct, slDistance, atrUsed: atr, tradeSize, filledAs };
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
  return size > 0 ? {
    side:           position.side,
    size,
    stopLoss:       parseFloat(position.stopLoss      || "0"),
    avgPrice:       parseFloat(position.avgPrice      || "0"),  // entry price from Bybit — reliable even after partial closes
    unrealizedPnl:  parseFloat(position.unrealisedPnl || "0"),  // Bybit field name: unrealisedPnl
  } : null;
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

// Format a price/distance value with enough decimal places to avoid rounding to zero.
// For low-price assets (e.g. HANAUSDT @ $0.0335), toFixed(2) would produce "0.00".
function formatPrice(value) {
  if (!value || value <= 0) return "0";
  if (value >= 1) return value.toFixed(2);
  const decimals = Math.max(2, -Math.floor(Math.log10(value)) + 2);
  return value.toFixed(decimals);
}

// atr: if provided, trailing distance = atr × ATR_MULTIPLIER (same buffer as the SL).
// Fallback: entryPrice × TRAILING_STOP_PCT (legacy fixed %).
// Stable coins (STABLE_SYMBOLS) use wider STABLE_TRAILING_STOP_PCT / STABLE_TRAILING_ACTIVATION_PCT.
async function setTrailingStop(symbol, action, entryPrice, atr = null) {
  const isStable = CONFIG.stableSymbols.includes(symbol.toUpperCase());
  const trailingStopPct      = isStable ? CONFIG.stableTrailingStopPct      : CONFIG.trailingStopPct;
  const trailingActivationPct = isStable ? CONFIG.stableTrailingActivationPct : CONFIG.trailingActivationPct;

  const rawDistance  = atr
    ? atr * CONFIG.atrMultiplier
    : entryPrice * trailingStopPct;
  const trailingDistance = formatPrice(rawDistance);

  // Guard: if distance rounds to zero Bybit will reject the request
  if (parseFloat(trailingDistance) === 0) {
    console.log(`  ⚠️  Trailing stop ignorado — distância calculada é zero (ATR demasiado pequeno)`);
    return;
  }

  // Desired activation price (trailingActivationPct in profit from entry)
  const activePriceNum = action === "buy"
    ? entryPrice * (1 + trailingActivationPct)
    : entryPrice * (1 - trailingActivationPct);

  // Check current price — if it already passed activePriceNum, Bybit rejects activePrice.
  // In that case omit it: trailing activates immediately (correct behaviour).
  const currentPrice = await fetchCurrentPrice(symbol);
  const alreadyActivated = currentPrice > 0 && (
    action === "buy"  ? currentPrice >= activePriceNum :
                        currentPrice <= activePriceNum
  );

  const src = atr ? `${CONFIG.atrMultiplier}×ATR($${parseFloat(atr).toFixed(4)})` : `${(trailingStopPct * 100).toFixed(1)}% fixo${isStable ? " (stable)" : ""}`;
  if (alreadyActivated) {
    console.log(`  Trailing stop: distance=$${trailingDistance} (${src}) | activa imediatamente (preço já passou $${activePriceNum.toFixed(2)})`);
  } else {
    console.log(`  Trailing stop: distance=$${trailingDistance} (${src}) | activa @ $${activePriceNum.toFixed(2)} (${(CONFIG.trailingActivationPct * 100).toFixed(2)}% de lucro)`);
  }

  const timestamp  = Date.now().toString();
  const recvWindow = "5000";
  const orderBody  = alreadyActivated
    ? { category: "linear", symbol, trailingStop: trailingDistance, positionIdx: 0 }
    : { category: "linear", symbol, trailingStop: trailingDistance, activePrice: formatPrice(activePriceNum), positionIdx: 0 };
  const body = JSON.stringify(orderBody);
  const sig  = sign(timestamp, recvWindow, body);
  const res  = await fetch(`${CONFIG.bybit.baseUrl}/v5/position/trading-stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BAPI-API-KEY": CONFIG.bybit.apiKey, "X-BAPI-SIGN": sig, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0) console.log(`  ⚠️  Trailing stop falhou: ${data.retMsg}`);
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

  const { secret, action, symbol, price, leverage, entry_price, atr: payloadAtr, interval: payloadInterval } = body;

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

  // ── Time filter (buy/sell only — TP always passes through) ────────────────
  if (actionLower !== "tp" && CONFIG.tradeHoursStart !== null && CONFIG.tradeHoursEnd !== null) {
    const hourUTC = new Date().getUTCHours();
    if (!isInTimeWindow(hourUTC, CONFIG.tradeHoursStart, CONFIG.tradeHoursEnd)) {
      const window = `${String(CONFIG.tradeHoursStart).padStart(2,"0")}:00–${String(CONFIG.tradeHoursEnd).padStart(2,"0")}:00 UTC`;
      console.log(`  ⏰ Fora do horário de trading (${String(hourUTC).padStart(2,"0")}:xx UTC | janela: ${window}) — sinal ignorado`);
      return;
    }
  }

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
      console.log(`  Posição: ${openPos.side} qty=${openPos.size} | PnL não realizado: ${openPos.unrealizedPnl >= 0 ? "+" : ""}$${openPos.unrealizedPnl.toFixed(2)}`);

      // TP loss guard: skip if unrealized PnL is below the configured minimum
      if (CONFIG.minTpPnlUSD !== 0 && openPos.unrealizedPnl < CONFIG.minTpPnlUSD) {
        const msg = `⏸ TP ignorado — PnL não realizado $${openPos.unrealizedPnl.toFixed(2)} < mínimo $${CONFIG.minTpPnlUSD} (posição em perda)`;
        console.log(`  ${msg}`);
        await sendTelegram(
          `⏸ <b>Bot v2 ${sym}</b> — TP ignorado\n` +
          `Posição ${openPos.side} ainda em perda\n` +
          `PnL atual: $${openPos.unrealizedPnl.toFixed(2)} | Mínimo para fechar: $${CONFIG.minTpPnlUSD}\n` +
          `A aguardar recuperação antes de executar TP`
        );
        return;
      }

      console.log(`  A fechar metade...`);
      const result = await closeHalfPosition(sym, openPos);
      console.log(`  ✅ METADE FECHADA — orderId=${result.orderId} | fechado=${result.closedQty} | resta=${result.remainingQty}`);
      logTrade(sym, openPos.side === "Buy" ? "sell" : "buy", priceNum, "", result.orderId, "LIVE", `TP: closed half (${result.closedQty}), remaining ${result.remainingQty}`);
      recordTpReceived(sym);

      // Entry price — use Bybit's avgPrice (always reliable) with payload entry_price as fallback
      const entryNum = (openPos.avgPrice > 0 ? openPos.avgPrice : null)
                    ?? (parseFloat(entry_price) > 0 ? parseFloat(entry_price) : null);
      if (entryNum) console.log(`  Entry price: $${entryNum} (${openPos.avgPrice > 0 ? "Bybit avgPrice" : "payload entry_price"})`);

      // PnL da operação: (exit - entry) × qty fechada
      const closedQtyNum = parseFloat(result.closedQty);
      let opPnl = null;
      if (entryNum && closedQtyNum > 0) {
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
      if (entryNum) {
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
            // TP1 — move SL to entry ± ATR buffer (avoids micro-retracções a bater no SL)
            let beBuffer = 0;
            if (CONFIG.breakEvenBufferAtr > 0) {
              try {
                const beAtr = await fetchATR(sym, CONFIG.candleInterval);
                beBuffer    = beAtr * CONFIG.breakEvenBufferAtr;
              } catch {}
            }
            const beSl = openPos.side === "Buy"
              ? entryNum - beBuffer   // long: SL ligeiramente abaixo da entrada
              : entryNum + beBuffer;  // short: SL ligeiramente acima da entrada
            newSl = parseFloat(beSl.toFixed(2));
            const bufLabel = beBuffer > 0
              ? ` (entry $${entryNum} ${openPos.side === "Buy" ? "-" : "+"} ${CONFIG.breakEvenBufferAtr}×ATR=$${beBuffer.toFixed(2)})`
              : "";
            console.log(`  ✅ SL break-even (TP1): → $${newSl}${bufLabel}`);
          }

          // Validate SL is on the correct side of current price before submitting.
          // For a Buy  position: SL must be < current price (stop loss is below).
          // For a Sell position: SL must be > current price (stop loss is above).
          // If the position is in loss at TP time the computed break-even can end up
          // on the wrong side, causing Bybit to reject the order.
          const slInvalid = newSl !== null && (
            openPos.side === "Buy"  ? newSl >= priceNum :
            openPos.side === "Sell" ? newSl <= priceNum : false
          );
          if (slInvalid) {
            console.log(`  ⚠️  SL break-even $${newSl} inválido para ${openPos.side} @ $${priceNum} — ajuste ignorado`);
            newSl = null;
          } else {
            await setBreakEvenStop(sym, newSl);
          }
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

      // ── Cooldown + daily SL limit ───────────────────────────────────────────
      const cooldownCheck = checkCooldownAndSlLimit(sym, actionLower, !!openPos);
      if (cooldownCheck.blocked) {
        console.log(`  ${cooldownCheck.reason}`);
        logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, "", "BLOCKED", cooldownCheck.reason);
        await sendTelegram(`${cooldownCheck.reason}\n<b>Bot v2 ${sym}</b> — sinal ${actionLower.toUpperCase()} ignorado`);
        return;
      }

      // ── Duplicate signal guard ──────────────────────────────────────────────
      if (openPos && openPos.side.toLowerCase() === actionLower) {
        console.log(`  ⚠️  Already ${openPos.side} (qty=${openPos.size}) — skipping duplicate signal`);
        logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, "", "SKIPPED", `Already ${openPos.side}`);
        await sendTelegram(`⏭ <b>Bot v2 ${sym}</b> — Sinal ignorado\nJá tem posição ${openPos.side} aberta (qty=${openPos.size})`);
        return;
      }

      // ── Trend filter ────────────────────────────────────────────────────────
      if (CONFIG.trendMarginPct > 0) {
        try {
          const trendInt = toBybitInterval(CONFIG.trendInterval);
          const ema      = await fetchTrendEMA(sym, trendInt, CONFIG.trendEmaPeriod);
          const diff     = (priceNum - ema) / ema; // >0 = price above EMA (bullish)
          const trendDir = diff >= 0 ? "BULLISH" : "BEARISH";
          console.log(`  Tendência EMA${CONFIG.trendEmaPeriod}(${trendInt}m): $${ema.toFixed(4)} | ${trendDir} | diff=${(diff * 100).toFixed(2)}%`);

          const againstTrend =
            (actionLower === "buy"  && diff < -CONFIG.trendMarginPct) ||
            (actionLower === "sell" && diff >  CONFIG.trendMarginPct);

          if (againstTrend) {
            const diffPct = (Math.abs(diff) * 100).toFixed(2);
            console.log(`  🚫 ${actionLower.toUpperCase()} bloqueado — ${diffPct}% contra tendência ${trendDir} (margem ${(CONFIG.trendMarginPct * 100).toFixed(1)}%)`);

            // Close existing opposite position before blocking the new order
            if (openPos) {
              console.log(`  🔄 A fechar ${openPos.side} (qty=${openPos.size}) — sinal contra tendência...`);
              const closeResult = await closePosition(sym, openPos);
              console.log(`  ✅ Posição fechada — ${closeResult.orderId}`);
              logTrade(sym, openPos.side === "Buy" ? "sell" : "buy", priceNum, CONFIG.tradeSize, closeResult.orderId, "LIVE", `Fechado — sinal ${actionLower} contra tendência ${trendDir}`);
            }

            await sendTelegram(
              `🚫 <b>Bot v2 ${sym}</b> — ${actionLower.toUpperCase()} bloqueado\n` +
              `Sinal ${diffPct}% contra tendência ${trendDir}\n` +
              `EMA${CONFIG.trendEmaPeriod}(${trendInt}m): $${ema.toFixed(4)} | Preço: $${priceNum}\n` +
              (openPos ? `📤 Posição ${openPos.side} fechada` : "Sem posição aberta")
            );
            return;
          }
          const isAligned = (actionLower === "buy" && diff >= 0) || (actionLower === "sell" && diff < 0);
          if (isAligned) {
            console.log(`  ✅ Filtro tendência OK: alinhado com ${trendDir} (diff=${(diff * 100).toFixed(2)}%)`);
          } else {
            console.log(`  ✅ Filtro tendência OK: ${(Math.abs(diff) * 100).toFixed(2)}% contra tendência — dentro da margem ${(CONFIG.trendMarginPct * 100).toFixed(1)}%`);
          }
        } catch (e) {
          console.log(`  ⚠️  Trend filter falhou: ${e.message} — a continuar`);
        }
      }

      // ── Close opposite position (normal reversal) ───────────────────────────
      if (openPos) {
        // Reversal loss guard: block if existing position loss exceeds threshold
        if (CONFIG.maxReversalLossUSD > 0 && openPos.unrealizedPnl < -CONFIG.maxReversalLossUSD) {
          const pnlDisplay = `$${openPos.unrealizedPnl.toFixed(2)}`;
          const msg = `⏸ Reversão bloqueada — ${openPos.side} tem PnL não realizado ${pnlDisplay} (limite: -$${CONFIG.maxReversalLossUSD})\nA aguardar recuperação antes de reverter para ${actionLower.toUpperCase()}`;
          console.log(`  ${msg}`);
          await sendTelegram(`⏸ <b>Bot v2 ${sym}</b> — Reversão bloqueada\n${msg}`);
          return;
        }
        const pnlInfo = CONFIG.maxReversalLossUSD > 0 ? ` | PnL: $${openPos.unrealizedPnl.toFixed(2)}` : "";
        console.log(`  🔄 Closing existing ${openPos.side} (qty=${openPos.size})${pnlInfo} before opening ${actionLower.toUpperCase()}...`);
        const closeResult = await closePosition(sym, openPos);
        console.log(`  ✅ POSITION CLOSED — ${closeResult.orderId}`);
        logTrade(sym, openPos.side.toLowerCase() === "buy" ? "sell" : "buy", priceNum, CONFIG.tradeSize, closeResult.orderId, "LIVE", `Closed ${openPos.side} — reversing to ${actionLower}`);
      }
    }

    // Resolve interval — payload {{interval}} takes priority over CANDLE_INTERVAL env var
    const candleInterval = toBybitInterval(payloadInterval || CONFIG.candleInterval);
    if (payloadInterval) console.log(`  Intervalo do payload: ${payloadInterval} → Bybit: ${candleInterval}m`);

    // Resolve ATR — payload first, then fetch from Bybit candles using signal's own interval
    const atrNum = payloadAtr ? parseFloat(payloadAtr) : null;
    let resolvedAtr = atrNum;
    if (resolvedAtr) {
      console.log(`  ATR recebido do payload: $${resolvedAtr.toFixed(4)}`);
    } else {
      try {
        resolvedAtr = await fetchATR(sym, candleInterval);
        console.log(`  ATR(${CONFIG.atrPeriod},${candleInterval}m) calculado: $${resolvedAtr.toFixed(4)}`);
      } catch (e) {
        console.log(`  ⚠️  ATR fetch falhou: ${e.message} — SL fixo será usado`);
      }
    }

    // ── Dynamic leverage ──────────────────────────────────────────────────────
    let dynLev = effectiveLev;
    if (CONFIG.dynamicLeverage && resolvedAtr) {
      try {
        const avg50 = await fetchATRAvg50(sym, candleInterval);
        dynLev      = calcDynamicLeverage(resolvedAtr, avg50, effectiveLev);
        const ratio = (resolvedAtr / avg50).toFixed(2);
        if (dynLev !== effectiveLev) {
          console.log(`  📊 Alavancagem dinâmica: ${effectiveLev}x → ${dynLev}x (ATR ${ratio}× acima da média)`);
        } else {
          console.log(`  ✅ Alavancagem dinâmica: ${dynLev}x (ATR ${ratio}× da média — sem redução)`);
        }
      } catch (e) {
        console.log(`  ⚠️  Alavancagem dinâmica falhou: ${e.message} — a usar ${effectiveLev}x`);
      }
    }

    // ── Volume filter ─────────────────────────────────────────────────────────
    if (CONFIG.volumeFilterMult > 0) {
      try {
        const { currentVol, avgVol, ratio } = await fetchVolumeRatio(sym, candleInterval, CONFIG.volumeFilterPeriods);
        if (ratio < CONFIG.volumeFilterMult) {
          const msg = `⏸ Volume baixo: ${ratio.toFixed(2)}× média — mínimo ${CONFIG.volumeFilterMult}× — sinal ignorado`;
          console.log(`  ${msg}`);
          await sendTelegram(`⏸ <b>Bot v2 ${sym}</b> — Sinal ignorado\n${msg}\nVol atual: ${currentVol.toFixed(0)} | Média(${CONFIG.volumeFilterPeriods}): ${avgVol.toFixed(0)}`);
          return;
        }
        console.log(`  ✅ Filtro volume OK: ${ratio.toFixed(2)}× média (mínimo ${CONFIG.volumeFilterMult}×)`);
      } catch (e) {
        console.log(`  ⚠️  Filtro volume falhou: ${e.message} — a continuar`);
      }
    }

    // ── Fee viability filter ──────────────────────────────────────────────────
    // Skip trade if expected TP1 profit (1:1 RR, half position) < round-trip fees × threshold.
    // Uses worst-case taker fee (0.055%) for both sides — if chase limit fires, we're even better off.
    if (CONFIG.feeViabilityThreshold > 0 && resolvedAtr) {
      const slPct           = (resolvedAtr * CONFIG.atrMultiplier) / priceNum;
      const notional        = CONFIG.tradeSize * effectiveLev;
      const feesRoundTrip   = notional * 0.00055 * 2;            // taker 0.055% × 2 sides
      const expectedTp1     = notional * slPct * 0.5;            // 1:1 RR on half position at TP1
      const minRequired     = feesRoundTrip * CONFIG.feeViabilityThreshold;
      if (expectedTp1 < minRequired) {
        const msg = `⏸ Trade ignorado — TP1 esperado ($${expectedTp1.toFixed(2)}) < taxas ($${feesRoundTrip.toFixed(2)}) × ${CONFIG.feeViabilityThreshold}`;
        console.log(`  ${msg}`);
        await sendTelegram(`⏸ <b>Bot v2 ${sym}</b> — Sinal ignorado\n${msg}\nSL% ${(slPct*100).toFixed(3)}% demasiado pequeno para cobrir taxas`);
        return;
      }
      console.log(`  ✅ Viabilidade taxas OK: TP1 $${expectedTp1.toFixed(2)} ≥ taxas $${feesRoundTrip.toFixed(2)} × ${CONFIG.feeViabilityThreshold}`);
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
          `ATR(${CONFIG.atrPeriod},${candleInterval}m)=$${resolvedAtr.toFixed(4)} → SL seria ${slPctStr}%\n` +
          `Limite configurado: ${limitPctStr}%`
        );
        return;
      }
      console.log(`  ✅ Filtro volatilidade OK: SL ${((resolvedAtr * CONFIG.atrMultiplier / priceNum) * 100).toFixed(2)}% ≤ ${(CONFIG.maxSlPct * 100).toFixed(1)}%`);
    }

    // ── Minimum R:R filter ────────────────────────────────────────────────────
    // TP is fired externally by TradingView, so we can't fix a static TP%.
    // Instead, we compute the *implied* TP target = SL × minRR (the minimum move the
    // strategy must achieve to satisfy the R:R requirement) and block only if that
    // implied target exceeds MAX_TP_PCT (unrealistically large given the volatility).
    if (CONFIG.minRR > 0 && resolvedAtr) {
      const slPct       = (resolvedAtr * CONFIG.atrMultiplier) / priceNum;
      const impliedTpPct = slPct * CONFIG.minRR;   // min move TradingView must target
      if (CONFIG.maxTpPct > 0 && impliedTpPct > CONFIG.maxTpPct) {
        const msg = `⏸ TP implícito ${(impliedTpPct * 100).toFixed(2)}% (SL ${(slPct * 100).toFixed(2)}% × ${CONFIG.minRR}) > máx ${(CONFIG.maxTpPct * 100).toFixed(2)}% — sinal ignorado`;
        console.log(`  ${msg}`);
        await sendTelegram(
          `⏸ <b>Bot v2 ${sym}</b> — Sinal ignorado\n` +
          `${msg}\n` +
          `ATR=${resolvedAtr.toFixed(4)} → SL=$${(resolvedAtr * CONFIG.atrMultiplier).toFixed(4)} (${(slPct * 100).toFixed(2)}%)\n` +
          `Para R:R≥${CONFIG.minRR} o TradingView teria de alvo ≥${(impliedTpPct * 100).toFixed(2)}% — demasiado`
        );
        return;
      }
      console.log(`  ✅ R:R OK: SL ${(slPct * 100).toFixed(2)}% → TP implícito ${(impliedTpPct * 100).toFixed(2)}% (×${CONFIG.minRR})${CONFIG.maxTpPct > 0 ? ` ≤ máx ${(CONFIG.maxTpPct * 100).toFixed(2)}%` : ""}`);
    }

    // ── Spread check ─────────────────────────────────────────────────────────
    if (CONFIG.maxSpreadPct > 0) {
      try {
        const { bid, ask, spreadPct } = await fetchSpreadPct(sym);
        if (spreadPct > CONFIG.maxSpreadPct) {
          const msg = `⏸ Spread demasiado largo: ${(spreadPct * 100).toFixed(4)}% (máx ${(CONFIG.maxSpreadPct * 100).toFixed(4)}%) — sinal ignorado`;
          console.log(`  ${msg}`);
          await sendTelegram(`⏸ <b>Bot v2 ${sym}</b> — Sinal ignorado\n${msg}\nBid: $${bid} | Ask: $${ask}`);
          return;
        }
        console.log(`  ✅ Spread OK: ${(spreadPct * 100).toFixed(4)}% ≤ ${(CONFIG.maxSpreadPct * 100).toFixed(4)}% (bid $${bid} / ask $${ask})`);
      } catch (e) {
        console.log(`  ⚠️  Spread check falhou: ${e.message} — a continuar`);
      }
    }

    const order = await placeOrder(sym, actionLower, priceNum, dynLev, resolvedAtr);
    const feeType = order.filledAs === "maker" ? "maker 0.02% 💚" : "taker 0.055%";
    console.log(`  ✅ ORDER PLACED — ${order.orderId} | ${feeType}`);
    recordSignalPlaced(sym, actionLower);

    if (CONFIG.tradeMode === "futures") {
      await setTrailingStop(sym, actionLower, priceNum, resolvedAtr);
    }

    const slLabel  = order.atrUsed
      ? `$${order.slPrice} (${(order.slPct * 100).toFixed(2)}% = ${CONFIG.atrMultiplier}×ATR)`
      : `$${order.slPrice} (${(order.slPct * 100).toFixed(2)}% fixo)`;
    const feeLabel = order.filledAs === "maker"
      ? "maker 0.02% 💚"
      : "taker 0.055%";

    logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, order.orderId, "LIVE", `SL=$${order.slPrice} | fee=${order.filledAs}`);
    await sendTelegram(
      `✅ <b>Bot v2 ${sym}</b> — LIVE ${actionLower.toUpperCase()}\n` +
      `Preço: $${priceNum} | Size: $${order.tradeSize ?? CONFIG.tradeSize}\n` +
      `SL: ${slLabel} | TP: via TradingView\n` +
      `Taxa: ${feeLabel}\n` +
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
loadSymbolState();
app.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradingView Webhook Bot v2");
  console.log(`  Port     : ${PORT}`);
  console.log(`  Mode     : ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Leverage : ${CONFIG.leverage}x`);
  console.log(`  Trade    : $${CONFIG.tradeSize} per signal${CONFIG.riskPerTradeUSD > 0 ? ` (risk-based $${CONFIG.riskPerTradeUSD})` : ""}`);
  console.log(`  SL       : ATR(${CONFIG.atrPeriod}, ${CONFIG.candleInterval}m) × ${CONFIG.atrMultiplier} | fallback ${CONFIG.stopLossPct * 100}%`);
  console.log(`  Vol.filter: ${CONFIG.maxSlPct > 0 ? `skip se SL > ${(CONFIG.maxSlPct * 100).toFixed(1)}%` : "desativado (MAX_SL_PCT=0)"}`);
  console.log(`  Tendência : ${CONFIG.trendMarginPct > 0 ? `EMA${CONFIG.trendEmaPeriod}(${CONFIG.trendInterval}m) | margem ${(CONFIG.trendMarginPct * 100).toFixed(1)}%` : "desativado (TREND_MARGIN_PCT=0)"}`);
  console.log(`  Chase Limit: ${CONFIG.chaseLimitEnabled ? `ativo — timeout ${CONFIG.chaseLimitTimeoutMs}ms → fallback Market` : "desativado (sempre Market)"}`);
  console.log(`  BE buffer : ${CONFIG.breakEvenBufferAtr > 0 ? `${CONFIG.breakEvenBufferAtr}×ATR abaixo/acima da entrada` : "desativado (SL exato na entrada)"}`);
  console.log(`  Fee filter: ${CONFIG.feeViabilityThreshold > 0 ? `skip se TP1 < taxas × ${CONFIG.feeViabilityThreshold}` : "desativado"}`);
  console.log(`  R:R mín   : ${CONFIG.minRR > 0 ? `${CONFIG.minRR} — TP implícito=SL×${CONFIG.minRR}${CONFIG.maxTpPct > 0 ? ` | bloq. se TP implícito > ${(CONFIG.maxTpPct*100).toFixed(2)}%` : " | sem cap (MAX_TP_PCT=0)"}` : "desativado (MIN_RR=0)"}`);
  console.log(`  TP guard  : ${CONFIG.minTpPnlUSD !== 0 ? `skip TP se PnL < $${CONFIG.minTpPnlUSD}` : "desativado — TP sempre executa (MIN_TP_PNL_USD para ativar)"}`);
  console.log(`  Reversão  : ${CONFIG.maxReversalLossUSD > 0 ? `bloqueada se perda > $${CONFIG.maxReversalLossUSD}` : "sempre permitida (MAX_REVERSAL_LOSS_USD=0)"}`);
  console.log(`  Lev.dinâm : ${CONFIG.dynamicLeverage ? "ativo (ATR>avg→75% | ATR>1.5×avg→50%)" : "desativado (DYNAMIC_LEVERAGE=true para ativar)"}`);
  console.log(`  Horário   : ${CONFIG.tradeHoursStart !== null ? `${String(CONFIG.tradeHoursStart).padStart(2,"0")}:00–${String(CONFIG.tradeHoursEnd).padStart(2,"0")}:00 UTC` : "24/7 (TRADE_HOURS_START/END para limitar)"}`);
  console.log(`  Volume    : ${CONFIG.volumeFilterMult > 0 ? `skip se vol < ${CONFIG.volumeFilterMult}× média(${CONFIG.volumeFilterPeriods})` : "desativado (VOLUME_FILTER_MULT para ativar)"}`);
  console.log(`  Timeout   : ${CONFIG.positionTimeoutHours > 0 ? `fecha após ${CONFIG.positionTimeoutHours}h se PnL entre $${CONFIG.positionTimeoutPnlMin} e $${CONFIG.positionTimeoutPnlMax}` : "desativado (POSITION_TIMEOUT_HOURS para ativar)"}`);
  console.log(`  Spread    : ${CONFIG.maxSpreadPct > 0 ? `skip se spread > ${(CONFIG.maxSpreadPct * 100).toFixed(4)}%` : "desativado (MAX_SPREAD_PCT para ativar)"}`);
  console.log(`  Cooldown  : ${CONFIG.cooldownAfterSlMs > 0 ? `${CONFIG.cooldownAfterSlMs / 60000}min após SL inferido` : "desativado"}${CONFIG.maxSlPerSymbol > 0 ? ` | bloqueia após ${CONFIG.maxSlPerSymbol} SL/dia` : ""}`);
  console.log(`  Stable    : ${CONFIG.stableSymbols.length > 0 ? `${CONFIG.stableSymbols.join(", ")} | activation ${CONFIG.stableTrailingActivationPct * 100}% | trailing ${CONFIG.stableTrailingStopPct * 100}%` : "desativado (STABLE_SYMBOLS vazio)"}`);
  console.log(`  Endpoint : POST /webhook`);
  console.log(`  Payload  : { "secret":"...", "action":"buy|sell", "symbol":"BTCUSDT", "price":75000, "atr":0.5 (opcional) }`);
  console.log("═══════════════════════════════════════════════════════════");

  // Start background position timeout checker (every 5 min)
  if (CONFIG.positionTimeoutHours > 0) {
    setInterval(checkPositionTimeouts, 5 * 60 * 1000);
    console.log(`⏱  Position timeout checker ativo — verifica a cada 5min`);
  }

  // Start Telegram command polling
  startTelegramPolling();
});
