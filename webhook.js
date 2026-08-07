import "dotenv/config";
import express from "express";
import crypto from "crypto";
import path from "path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

// Persisted state/log live under DATA_DIR. Set DATA_DIR to a mounted Railway Volume path
// (e.g. /data) so symbol-state.json and the trade log survive redeploys/restarts.
// Default "." keeps the old behaviour (current working dir) for local runs.
const DATA_DIR = process.env.DATA_DIR || ".";
try { if (DATA_DIR !== "." && !existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Default timeout for every outgoing HTTP call. Node's fetch has NO timeout: a hung
// connection to the exchange would leave a command waiting forever — no reply, no error,
// no recovery. Shadowing fetch module-wide applies the timeout to all call sites at once
// while respecting any explicit `signal` (Telegram's long-poll and sends set their own).
const _rawFetch = globalThis.fetch;
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || "20000");
function fetch(url, opts = {}) {
  return opts.signal
    ? _rawFetch(url, opts)
    : _rawFetch(url, { ...opts, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  bingx: {
    apiKey:    process.env.BINGX_API_KEY,
    secretKey: process.env.BINGX_SECRET_KEY,
    baseUrl:   process.env.BINGX_BASE_URL || "https://open-api.bingx.com",
  },
  webhookSecret:    process.env.WEBHOOK_SECRET     || "",
  paperTrading:     process.env.PAPER_TRADING      !== "false",
  tradeMode:        process.env.TRADE_MODE         || "futures",
  tradeSize:        parseFloat(process.env.MAX_TRADE_SIZE_USD  || "100"),
  leverage:         parseInt(process.env.LEVERAGE              || "100"),
  stopLossPct:      parseFloat(process.env.STOP_LOSS_PCT       || "0.002"),
  takeProfitPct:    parseFloat(process.env.TAKE_PROFIT_PCT     || "0.004"),
  trailingStopPct:        parseFloat(process.env.TRAILING_STOP_PCT        || "0.03"),
  // Trailing-stop distance multiplier — applied to ATR for the trailing distance,
  // independent of ATR_MULTIPLIER (which sets the SL). A smaller value locks profit
  // tighter once the trail activates (gives back less of the move) at the cost of
  // being stopped out by noise more easily. Breakeven guarantee is preserved either
  // way (activation = entry ± distance → initial stop = entry). 0 = use ATR_MULTIPLIER.
  trailingAtrMult:        parseFloat(process.env.TRAILING_ATR_MULT        || "0"),
  // Stable coins (e.g. BTC, SOL, ETH): wider trailing to avoid early stop-outs.
  // STABLE_SYMBOLS = comma-separated list of symbols (e.g. BTCUSDT,SOLUSDT,ETHUSDT)
  // Leave empty to disable the feature (all symbols use the defaults above).
  stableSymbols:              (process.env.STABLE_SYMBOLS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
  stableTrailingStopPct:      parseFloat(process.env.STABLE_TRAILING_STOP_PCT       || "0.05"),
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
  // Since TP is fired by TradingView (not placed on BingX), the TP reference is computed
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
  // Reversal hard cap: if an opposite signal arrives while the open position's
  // unrealized loss exceeds this many USD, force-close it (cut the loss) and skip
  // the new entry — overrides the MAX_REVERSAL_LOSS_USD "hold for recovery" guard.
  // Caps tail risk under Cross margin, where a runaway loser drains the shared balance.
  // 0 = disabled.
  maxReversalHardCapUSD: parseFloat(process.env.MAX_REVERSAL_HARD_CAP_USD || "0"),
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
  // Trailing-stop re-entry: if a position is closed by the trailing-stop at breakeven/profit
  // (no SL hit, no TP signal), arm a re-entry watch at the exit price. If price later breaks
  // back past that level in the original direction, re-enter — at most once per
  // REENTRY_COOLDOWN_MS (default 1h, i.e. one 1h candle). The watch expires after
  // REENTRY_EXPIRY_HOURS with no breakout, or is cancelled by any new buy/sell signal.
  // 0/false = disabled.
  trailingReentryEnabled: process.env.TRAILING_REENTRY_ENABLED === "true",
  reentryCooldownMs:      parseInt(process.env.REENTRY_COOLDOWN_MS || "3600000"),  // 1h
  reentryExpiryHours:     parseFloat(process.env.REENTRY_EXPIRY_HOURS || "6"),
  // Manual /commit3 Telegram command: close a position (bank the gain) and arm a
  // PULLBACK re-entry — re-enter the same direction once price retraces this % from the
  // exit (buy the dip for a long / sell the rip for a short). Cancelled by an opposite
  // signal; expires after REENTRY_EXPIRY_HOURS (shared with the breakout re-entry).
  // Pullback distance for the /commit3 re-entry. Dynamic: ATR × COMMIT_PULLBACK_ATR_MULT
  // (adapts to each pair's volatility — "half an average candle" of retrace by default).
  // Falls back to the fixed COMMIT_PULLBACK_PCT when ATR can't be fetched.
  commitPullbackAtrMult:  parseFloat(process.env.COMMIT_PULLBACK_ATR_MULT || "0.5"),
  commitPullbackPct:      parseFloat(process.env.COMMIT_PULLBACK_PCT || "0.003"),  // 0.3% fallback
  // Breakout fallback for the commit re-entry: if the resting pullback limit never fills
  // and price instead breaks ATR × this multiplier PAST the exit in the original direction,
  // cancel the limit and re-enter at market (mirroring qty/leverage) so the move isn't lost.
  // 0 = disabled (limit-only, may expire unfilled).
  commitBreakoutAtrMult:  parseFloat(process.env.COMMIT_BREAKOUT_ATR_MULT || "0.5"),
  // /commit3 with no argument lists one button per open symbol whose unrealized gain
  // exceeds this many USD, so you can bank it with one tap.
  commitMinGainUSD:       parseFloat(process.env.COMMIT_MIN_GAIN_USD || "5"),
  // Auto-commit: automatically bank a position (same flow as /commit3 — close + pullback
  // limit re-entry) once its unrealized gain reaches the threshold. Checked every 1 min.
  // AUTO_COMMIT_GAIN_PCT: threshold as % of the position's own margin (ROI — e.g. 100 =
  //   gain equals the margin). Scales with position size and leverage, so manual positions
  //   and different leverages are treated proportionally. Takes precedence when > 0.
  // AUTO_COMMIT_GAIN_USD: fixed-USD alternative, used when PCT is 0.
  // Both 0 = disabled (manual /commit3 only).
  autoCommitGainPct:      parseFloat(process.env.AUTO_COMMIT_GAIN_PCT || "0"),
  autoCommitGainUSD:      parseFloat(process.env.AUTO_COMMIT_GAIN_USD || "0"),
  // BingX API keys without an IP whitelist expire every 3 months. Checked daily; a
  // Telegram warning is sent each day once ≤ this many days remain. 0 = disabled.
  apiKeyExpiryWarnDays:   parseFloat(process.env.API_KEY_EXPIRY_WARN_DAYS || "7"),
};

const LOG_FILE = path.join(DATA_DIR, "webhook-trades.csv");
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

const SYMBOL_STATE_FILE = path.join(DATA_DIR, "symbol-state.json");
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
function recordSignalPlaced(symbol, action, price = null, leverage = null, interval = null) {
  const s = _getSymState(symbol);
  if (action === "buy") s.lastBuyTime = Date.now();
  else                  s.lastSellTime = Date.now();
  s.positionOpenTime = Date.now(); // for position timeout tracking
  s.lastAction       = action;     // for trailing-stop re-entry direction
  s.lastEntryPrice   = price;
  if (leverage != null && leverage > 0) s.lastLeverage = leverage; // so a re-entry mirrors this leverage
  if (interval) s.lastInterval = interval; // so re-entry ATR uses the same candle interval as the entry
  delete s.reentry;                 // a fresh entry supersedes any pending re-entry watch
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
//   Then confirmed against the actual closed-pnl: a breakeven/profit exit (trailing-stop)
//   is NOT an SL and must not trigger cooldown — otherwise winning trailing exits would
//   block the very re-entry the re-entry watcher wants to make.
//   If SL confirmed → increment daily counter → check cooldown and daily limit.
// Returns { blocked, reason } — side-effect: persists SL count if SL is confirmed.
async function checkCooldownAndSlLimit(symbol, action, hasOpenPosition) {
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

  // Confirm against actual closed PnL: if the position that followed lastSameDir was
  // closed at breakeven/profit (closedPnl ≥ 0 → trailing-stop, not an SL), do NOT count
  // it as an SL and do NOT apply cooldown. (Fee-sized negative closes may still be read
  // as SL — acceptable, as a real ATR×mult SL loss is far larger than round-trip fees.)
  try {
    const last = await getLastClosedPnl(symbol);
    if (last && parseFloat(last.updatedTime) >= lastSameDir && parseFloat(last.closedPnl) >= 0) {
      console.log(`  ✅ ${symbol} (${action}): última saída foi ganho/breakeven ($${parseFloat(last.closedPnl).toFixed(2)}) — trailing-stop, não SL → sem cooldown`);
      return { blocked: false };
    }
  } catch (e) {
    console.log(`  ⚠️  ${symbol}: verificação closed-pnl falhou (${e.message}) — a assumir SL`);
  }

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
    signal: AbortSignal.timeout(15000),  // sem timeout, um envio podia ficar pendurado
  }).catch((e) => console.log("Telegram error:", e.message));
}

// Send a message with a one-time reply keyboard. `rows` is an array of rows, each a
// list of button labels (strings). Tapping a button sends its label as a normal message,
// so labels like "/commit3 BTCUSDT" route straight through handleTelegramCommand.
async function sendTelegramKeyboard(message, rows, chatId = null) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const target = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !target) return;
  const keyboard = rows.map(row => row.map(label => ({ text: label })));
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: target, text: message, parse_mode: "HTML",
      reply_markup: { keyboard, one_time_keyboard: true, resize_keyboard: true },
    }),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => console.log("Telegram error:", e.message));
}

// Returns all open perpetual positions with size > 0 (across all symbols).
// BingX returns everything in one call (no settleCoin split needed).
async function getAllOpenPositions() {
  const data = await bxRequest("GET", "/openApi/swap/v2/user/positions", {});
  const out = [];
  for (const p of (Array.isArray(data) ? data : [])) {
    const size = Math.abs(parseFloat(p.positionAmt || "0"));
    if (size > 0) {
      out.push({
        symbol:        fromBingxSymbol(p.symbol),
        side:          p.positionSide === "SHORT" || parseFloat(p.positionAmt) < 0 ? "Sell" : "Buy",
        size,
        avgPrice:      parseFloat(p.avgPrice || "0"),
        markPrice:     parseFloat(p.markPrice || "0"),  // current price
        unrealizedPnl: parseFloat(p.unrealizedProfit || p.unrealisedProfit || "0"),
        leverage:      parseFloat(p.leverage || "0"),   // for margin/ROI calc
        stopLoss:      "",                              // SL vive em ordens separadas na BingX (ver getOpenPosition)
      });
    }
  }
  return out;
}

// ─── Telegram Command Polling ─────────────────────────────────────────────────
// Polls getUpdates in a loop so the bot can respond to commands sent in the chat.
// Supported commands:
//   /pnl3  — daily closed PnL (total + per symbol)
//   /pos3  — open positions summary

// Fetch all realized-PnL records in [startTime, endTime], chunked into ≤6-day windows
// (income queries are range-limited) — records shaped like BingX's closed-pnl entries
// ({ symbol, closedPnl, updatedTime }) so the stats renderer stays unchanged.
async function fetchClosedPnlRange(startTime, endTime) {
  const records = [];
  const CHUNK = 6 * 86_400_000;
  for (let from = startTime; from < endTime; from += CHUNK) {
    const to = Math.min(from + CHUNK, endTime);
    try {
      records.push(...await fetchIncomeRange(from, to));
    } catch (e) {
      console.log(`  ⚠️  fetchClosedPnlRange chunk falhou: ${e.message}`);
    }
  }
  return records;
}

// Renders the N-day PnL summary + bar chart, bucketed by `groupDays` days per row
// (1 = daily rows for /stats7; 7 = weekly rows for /stats30)
async function sendPnlStats(nDays, chatId, groupDays = 1) {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (nDays - 1)); // today + previous nDays-1 days
    const startTime = start.getTime();
    const now       = Date.now();

    const records = await fetchClosedPnlRange(startTime, now);

    // Buckets of groupDays days (server-local midnight, same convention as /pnl3)
    const fmt = (ms) => {
      const d = new Date(ms);
      return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
    };
    const bucketMs = groupDays * 86_400_000;
    const nBuckets = Math.ceil(nDays / groupDays);
    const buckets  = [];
    for (let i = 0; i < nBuckets; i++) {
      const from = startTime + i * bucketMs;
      const to   = Math.min(from + bucketMs - 86_400_000, now); // last day of the bucket
      buckets.push({
        label: groupDays === 1 ? fmt(from) : `${fmt(from)}–${fmt(to)}`,
        pnl: 0, trades: 0,
      });
    }
    let total = 0;
    for (const r of records) {
      const idx = Math.floor((parseInt(r.updatedTime) - startTime) / bucketMs);
      if (idx < 0 || idx >= nBuckets) continue;
      const pnl = parseFloat(r.closedPnl || 0);
      buckets[idx].pnl    += pnl;
      buckets[idx].trades += 1;
      total += pnl;
    }

    // Bar chart: blocks scaled to the biggest bucket (🟩 gain / 🟥 loss / — no trades)
    const maxAbs = Math.max(...buckets.map(b => Math.abs(b.pnl)), 0.01);
    const lines = buckets.map(b => {
      const blocks = b.pnl === 0 ? 0 : Math.max(1, Math.round((Math.abs(b.pnl) / maxAbs) * 6));
      const bar    = b.trades === 0 && b.pnl === 0 ? "—" : (b.pnl >= 0 ? "🟩" : "🟥").repeat(blocks) || "·";
      return `${b.label} ${bar} ${b.pnl >= 0 ? "+" : ""}$${b.pnl.toFixed(2)}${b.trades > 0 ? ` (${b.trades})` : ""}`;
    });

    const emoji = total >= 0 ? "🟢" : "🔴";
    await sendTelegram(
      `${emoji} <b>PnL últimos ${nDays} dias — Bot v3</b>${groupDays > 1 ? ` <i>(por semana)</i>` : ""}\n` +
      `<b>Total: ${total >= 0 ? "+" : ""}$${total.toFixed(2)}</b>\n\n` +
      lines.join("\n"),
      chatId
    );
  } catch (e) {
    await sendTelegram(`❌ Erro ao obter stats: ${e.message}`, chatId);
  }
}

async function handleTelegramCommand(text, chatId) {
  const cmd = (text || "").trim().split(/\s+/)[0].toLowerCase().replace(/@\S+/, "");

  if (cmd === "/pnl3") {
    try {
      // Fetch all closed trades today (no symbol filter) and group by symbol
      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);
      const list = await fetchIncomeRange(todayMidnight.getTime(), Date.now());

      // Group by symbol and by income type (liquidations/fees/funding are separate
      // records on BingX — the breakdown shows WHY the total is what it is)
      const bySymbol = {};
      const byType   = {};
      let total = 0;
      for (const item of list) {
        const sym = item.symbol;
        const pnl = parseFloat(item.closedPnl || 0);
        if (sym) bySymbol[sym] = (bySymbol[sym] || 0) + pnl;
        byType[item.incomeType || "?"] = (byType[item.incomeType || "?"] || 0) + pnl;
        total += pnl;
      }

      const TYPE_LABEL = {
        REALIZED_PNL:    "💵 Trades fechadas",
        INSURANCE_CLEAR: "💥 Liquidações",
        TRADING_FEE:     "🧾 Taxas",
        FUNDING_FEE:     "⏳ Funding",
      };

      const todayStr = new Date().toISOString().slice(0, 10);
      const lines = Object.entries(bySymbol)
        .sort((a, b) => b[1] - a[1])
        .map(([sym, pnl]) => `  ${sym}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
      const typeLines = Object.entries(byType)
        .sort((a, b) => a[1] - b[1])
        .map(([t, v]) => `  ${TYPE_LABEL[t] || t}: ${v >= 0 ? "+" : ""}$${v.toFixed(2)}`);

      const emoji = total >= 0 ? "🟢" : "🔴";
      const msg = [
        `${emoji} <b>PnL do dia — Bot v3</b> (${todayStr})`,
        `<b>Total: ${total >= 0 ? "+" : ""}$${total.toFixed(2)}</b>`,
        typeLines.length > 0 ? "\nDecomposição:\n" + typeLines.join("\n") : "",
        lines.length > 0 ? "\nPor símbolo:\n" + lines.join("\n") : "\nNenhuma trade fechada hoje.",
      ].filter(Boolean).join("\n");

      await sendTelegram(msg, chatId);
    } catch (e) {
      await sendTelegram(`❌ Erro ao obter PnL: ${e.message}`, chatId);
    }
    return;
  }

  // /stats7 (por dia) e /stats30 (agregado por semana)
  if (cmd === "/stats7" || cmd === "/stats30") {
    await sendPnlStats(cmd === "/stats30" ? 30 : 7, chatId, cmd === "/stats30" ? 7 : 1);
    return;
  }

  if (cmd === "/pos3") {
    try {
      const positions = await getAllOpenPositions(); // USDT + USDC settled

      if (positions.length === 0) {
        await sendTelegram(`📭 <b>Bot v3</b> — Sem posições abertas`, chatId);
        return;
      }

      const lines = positions.map(p => {
        const emoji = p.unrealizedPnl >= 0 ? "🟢" : "🔴";
        return `${emoji} <b>${p.symbol}</b> ${p.side} | qty=${p.size} | entry=$${formatPrice(p.avgPrice)} | atual=$${formatPrice(p.markPrice)}\n   PnL: ${p.unrealizedPnl >= 0 ? "+" : ""}$${p.unrealizedPnl.toFixed(2)} | SL=$${p.stopLoss || "—"}`;
      });

      const totalPnl   = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
      const totalEmoji = totalPnl >= 0 ? "🟢" : "🔴";
      const totalLine  = `${totalEmoji} <b>Total (${positions.length} posições): ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}</b>`;

      await sendTelegram(`📊 <b>Posições abertas — Bot v3</b>\n\n${lines.join("\n\n")}\n\n${totalLine}`, chatId);
    } catch (e) {
      await sendTelegram(`❌ Erro ao obter posições: ${e.message}`, chatId);
    }
    return;
  }

  // /commit3          → list one button per symbol with unrealized gain > COMMIT_MIN_GAIN_USD
  // /commit3 SYMBOL   → close that position (bank the gain) + arm a pullback re-entry
  if (cmd === "/commit3") {
    if (CONFIG.paperTrading) {
      await sendTelegram(`📋 <b>Bot v3</b> — /commit3 só funciona em modo LIVE (atual: paper)`, chatId);
      return;
    }
    const argSym = ((text || "").trim().split(/\s+/)[1] || "").toUpperCase();

    if (argSym) {
      await commitSymbol(argSym, chatId);
      return;
    }

    // No argument → build the dynamic menu of winners above the threshold
    try {
      const positions = await getAllOpenPositions();
      const winners   = positions
        .filter(p => p.unrealizedPnl > CONFIG.commitMinGainUSD)
        .sort((a, b) => b.unrealizedPnl - a.unrealizedPnl);

      if (winners.length === 0) {
        await sendTelegram(`📭 <b>Bot v3</b> — nenhum símbolo com ganho > $${CONFIG.commitMinGainUSD}`, chatId);
        return;
      }

      const listText = winners.map(p => `• <b>${p.symbol}</b> ${p.side}: +$${p.unrealizedPnl.toFixed(2)} | preço $${formatPrice(p.markPrice)} (entrada $${formatPrice(p.avgPrice)})`).join("\n");
      const rows     = winners.map(p => [`/commit3 ${p.symbol}`]);
      await sendTelegramKeyboard(
        `💰 <b>Encaixar ganho</b> — símbolos com PnL > $${CONFIG.commitMinGainUSD}:\n${listText}\n\nToca para encaixar 👇`,
        rows,
        chatId
      );
    } catch (e) {
      await sendTelegram(`❌ Erro ao listar ganhos: ${e.message}`, chatId);
    }
    return;
  }

  // /close3                    → list one button per open position (any PnL)
  // /close3 SYMBOL             → ask for confirmation (guards against accidental taps)
  // /close3 SYMBOL confirmar   → actually close, NO re-entry (also cancels any pending
  //                              re-entry watch/limit order for the symbol)
  if (cmd === "/close3") {
    if (CONFIG.paperTrading) {
      await sendTelegram(`📋 <b>Bot v3</b> — /close3 só funciona em modo LIVE (atual: paper)`, chatId);
      return;
    }
    // Sintaxe: /close3 [SYMBOL] [quantidade] [confirmar]
    //   /close3                    → menu com as posições abertas
    //   /close3 BTCUSDT            → pede confirmação (fecho TOTAL)
    //   /close3 BTCUSDT 10         → pede confirmação (fecho PARCIAL de 10 unidades)
    //   /close3 BTCUSDT confirmar  → executa o fecho total
    //   /close3 BTCUSDT 10 confirmar → executa o fecho parcial
    const parts  = (text || "").trim().split(/\s+/);
    const argSym = (parts[1] || "").toUpperCase();
    const rest   = parts.slice(2).map(p => p.toLowerCase());
    const confirmed = rest.includes("confirmar");
    const qtyArg    = rest.find(p => p !== "confirmar");
    const qtyNum    = qtyArg !== undefined ? parseFloat(qtyArg.replace(",", ".")) : null;

    if (argSym) {
      if (qtyArg !== undefined && !(qtyNum > 0)) {
        await sendTelegram(`⚠️ Quantidade inválida: <code>${qtyArg}</code>\nUso: <code>/close3 ${argSym} 10</code> (10 unidades) ou <code>/close3 ${argSym}</code> (fecho total)`, chatId);
        return;
      }
      // Second step: only close when explicitly confirmed
      if (confirmed) {
        await closeSymbol(argSym, chatId, qtyNum);
        return;
      }
      // First step: show the position and ask for confirmation. The "Cancelar" button
      // sends plain text (no leading /), which the command poller simply ignores.
      try {
        const pos = await getOpenPosition(argSym);
        if (!pos) {
          await sendTelegram(`⚠️ <b>Bot v3 ${argSym}</b> — sem posição aberta para fechar`, chatId);
          return;
        }
        const partial = qtyNum > 0 && qtyNum < pos.size;
        if (qtyNum > pos.size) {
          await sendTelegram(`⚠️ <b>${argSym}</b> — pediste ${qtyNum} mas a posição só tem ${pos.size}. Usa <code>/close3 ${argSym}</code> para fechar tudo.`, chatId);
          return;
        }
        const cmdConfirm = partial ? `/close3 ${argSym} ${qtyNum} confirmar` : `/close3 ${argSym} confirmar`;
        await sendTelegramKeyboard(
          `⚠️ <b>Confirmas ${partial ? `fechar ${qtyNum} de ${argSym}` : `fechar ${argSym}`}?</b>\n` +
          `${pos.side} qty=${pos.size} | entrada $${formatPrice(pos.avgPrice)}\n` +
          `PnL atual: ${pos.unrealizedPnl >= 0 ? "+" : ""}$${pos.unrealizedPnl.toFixed(2)}\n` +
          (partial
            ? `Fecho PARCIAL a mercado — restam ${(pos.size - qtyNum).toFixed(8).replace(/\.?0+$/, "")} (posição mantém-se aberta).`
            : `Fecha a mercado, SEM re-entrada (cancela re-entradas pendentes).`),
          [[cmdConfirm], ["❌ Cancelar"]],
          chatId
        );
      } catch (e) {
        await sendTelegram(`❌ <b>Bot v3 ${argSym}</b> — erro ao obter posição\n${e.message}`, chatId);
      }
      return;
    }

    // No argument → list ALL open positions (closing a loser is a valid use here)
    try {
      const positions = (await getAllOpenPositions()).sort((a, b) => b.unrealizedPnl - a.unrealizedPnl);
      if (positions.length === 0) {
        await sendTelegram(`📭 <b>Bot v3</b> — Sem posições abertas para fechar`, chatId);
        return;
      }
      const listText = positions.map(p => `${p.unrealizedPnl >= 0 ? "🟢" : "🔴"} <b>${p.symbol}</b> ${p.side}: ${p.unrealizedPnl >= 0 ? "+" : ""}$${p.unrealizedPnl.toFixed(2)} | preço $${formatPrice(p.markPrice)} (entrada $${formatPrice(p.avgPrice)})`).join("\n");
      const rows     = positions.map(p => [`/close3 ${p.symbol}`]);
      await sendTelegramKeyboard(
        `✂️ <b>Fechar posição</b> (sem re-entrada):\n${listText}\n\nToca para fechar 👇`,
        rows,
        chatId
      );
    } catch (e) {
      await sendTelegram(`❌ Erro ao listar posições: ${e.message}`, chatId);
    }
    return;
  }
}

// Close a symbol's position with NO re-entry — /close3.
// qty = null (default) closes the whole position: also cancels any pending re-entry
// (software watch or resting BingX limit order) and clears positionOpenTime so the
// breakout auto-detector doesn't re-arm a watch for this closure.
// qty > 0 closes only that many contracts: the position stays open, so the state,
// SL/trailing and any pending re-entry are deliberately left untouched.
async function closeSymbol(argSym, chatId, qty = null) {
  try {
    const pos = await getOpenPosition(argSym);
    if (!pos) {
      await sendTelegram(`⚠️ <b>Bot v3 ${argSym}</b> — sem posição aberta para fechar`, chatId);
      return;
    }
    const pnl       = pos.unrealizedPnl;
    const exitPrice = (await fetchCurrentPrice(argSym)) || pos.avgPrice;
    const partial   = qty > 0 && qty < pos.size;

    // ── Fecho PARCIAL ────────────────────────────────────────────────────────
    if (partial) {
      const result = await closePartialPosition(argSym, pos, qty);
      const pnlShare = pnl * (parseFloat(result.closedQty) / pos.size); // PnL proporcional
      console.log(`  ✂️ /close3 ${argSym}: fecho parcial ${result.closedQty}/${pos.size} @ $${exitPrice} (PnL ~$${pnlShare.toFixed(2)}) — ${result.orderId}`);
      logTrade(argSym, pos.side === "Buy" ? "sell" : "buy", exitPrice, "", result.orderId, "LIVE", `/close3 parcial — ${result.closedQty} de ${pos.size} (PnL ~$${pnlShare.toFixed(2)})`);
      await sendTelegram(
        `${pnlShare >= 0 ? "🟢" : "🔴"} <b>Bot v3 ${argSym}</b> — Fecho parcial (/close3)\n` +
        `Fechado: ${result.closedQty} de ${pos.size} ${pos.side} @ $${formatPrice(exitPrice)}\n` +
        `PnL da parte fechada: ~${pnlShare >= 0 ? "+" : ""}$${pnlShare.toFixed(2)}\n` +
        `📌 Resta ${result.remainingQty} aberto (SL/trailing mantidos)`,
        chatId
      );
      return;
    }

    // ── Fecho TOTAL ──────────────────────────────────────────────────────────
    const result = await closePosition(argSym, pos);
    console.log(`  ✂️ /close3 ${argSym}: ${pos.side} fechado @ $${exitPrice} (PnL ~$${pnl.toFixed(2)}) — ${result.orderId}`);

    const s = _getSymState(argSym);
    s.positionOpenTime = null; // prevents the breakout auto-detector from arming a watch
    let cancelledReentry = false;
    if (s.reentry) {
      if (s.reentry.type === "limit" && s.reentry.orderId) {
        try { await cancelOrder(argSym, s.reentry.orderId); cancelledReentry = true; } catch {}
      } else {
        cancelledReentry = true;
      }
      delete s.reentry;
    }
    saveSymbolState();

    logTrade(argSym, pos.side === "Buy" ? "sell" : "buy", exitPrice, "", result.orderId, "LIVE", `/close3 — fechado sem re-entrada (PnL ~$${pnl.toFixed(2)})`);
    await sendTelegram(
      `${pnl >= 0 ? "🟢" : "🔴"} <b>Bot v3 ${argSym}</b> — Posição fechada (/close3)\n` +
      `${pos.side} fechada @ $${formatPrice(exitPrice)} | PnL ~${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n` +
      `Sem re-entrada${cancelledReentry ? " | re-entrada pendente cancelada" : ""}`,
      chatId
    );
  } catch (e) {
    await sendTelegram(`❌ <b>Bot v3 ${argSym}</b> — /close3 falhou\n${e.message}`, chatId);
  }
}

// Close a symbol's position (bank the gain) and arm a pullback re-entry — same direction,
// re-entering once price retraces the pullback distance from the exit.
// Used by /commit3 SYMBOL (manual) and checkAutoCommit (source label distinguishes them).
async function commitSymbol(argSym, chatId, source = "/commit3") {
  try {
    const pos = await getOpenPosition(argSym);
    if (!pos) {
      await sendTelegram(`⚠️ <b>Bot v3 ${argSym}</b> — sem posição aberta para encaixar`, chatId);
      return;
    }
    const sideAction = pos.side === "Buy" ? "buy" : "sell";
    const pnl        = pos.unrealizedPnl;
    const exitPrice  = (await fetchCurrentPrice(argSym)) || pos.avgPrice;
    // Mirror protection presence: if the original position ran without SL / trailing
    // (deliberate user choice), the re-entry must not add them either. A configured TP
    // level (a market target) is inherited as-is.
    const hadSL    = pos.stopLoss > 0;
    const hadTrail = pos.trailingStop > 0;
    const tpPrice  = pos.takeProfit > 0 ? pos.takeProfit : null;

    const result = await closePosition(argSym, pos);
    console.log(`  💰 ${source} ${argSym}: ${pos.side} fechado @ $${exitPrice} (PnL ~$${pnl.toFixed(2)}) — ${result.orderId}`);

    // Pullback distance: dynamic ATR × COMMIT_PULLBACK_ATR_MULT, fallback to fixed %.
    // ATR uses the same candle interval as the original entry when known.
    const cInterval = symbolState[argSym]?.lastInterval || CONFIG.candleInterval;
    let pullbackAtr = null;
    try { pullbackAtr = await fetchATR(argSym, cInterval); } catch {}
    const pullbackDist = pullbackAtr
      ? pullbackAtr * CONFIG.commitPullbackAtrMult
      : exitPrice * CONFIG.commitPullbackPct;
    const pullbackSrc  = pullbackAtr
      ? `${CONFIG.commitPullbackAtrMult}×ATR`
      : `${(CONFIG.commitPullbackPct * 100).toFixed(2)}% fixo`;
    const pullbackPctShown = (pullbackDist / exitPrice) * 100;

    const triggerLevel = sideAction === "buy"
      ? exitPrice - pullbackDist
      : exitPrice + pullbackDist;

    // Volatility filter (same MAX_SL_PCT rule as normal entries): if the implied ATR-based
    // SL is too wide, bank the gain but do NOT re-enter — a wide SL at high leverage is
    // decorative (real loss ≈ notional × SL%, which can approach the whole account in Cross).
    // positionOpenTime stays cleared so the breakout auto-detector doesn't arm a watch either.
    // Skipped when the original position had no SL (no SL will be attached — see hadSL).
    if (CONFIG.maxSlPct > 0 && pullbackAtr && hadSL) {
      const impliedSlPct = (pullbackAtr * CONFIG.atrMultiplier) / triggerLevel;
      if (impliedSlPct > CONFIG.maxSlPct) {
        const s0 = _getSymState(argSym);
        s0.positionOpenTime = null;
        delete s0.reentry;
        saveSymbolState();
        const msg = `SL implícito ${(impliedSlPct * 100).toFixed(2)}% > limite ${(CONFIG.maxSlPct * 100).toFixed(1)}% — volatilidade alta, sem re-entrada`;
        console.log(`  ⏸ ${argSym}: ${msg}`);
        logTrade(argSym, pos.side === "Buy" ? "sell" : "buy", exitPrice, "", result.orderId, "LIVE", `${source} — encaixou PnL ~$${pnl.toFixed(2)}, re-entrada bloqueada (SL ${(impliedSlPct * 100).toFixed(2)}%)`);
        await sendTelegram(
          `${pnl >= 0 ? "🟢" : "🔴"} <b>Bot v3 ${argSym}</b> — Ganho encaixado (${source})\n` +
          `Posição ${pos.side} fechada @ $${formatPrice(exitPrice)} | PnL ~${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n` +
          `⏸ Sem re-entrada: ${msg}`,
          chatId
        );
        return;
      }
    }

    // Place a real GTC limit order on BingX at the dip/rip level. Unlike an in-memory
    // watch, this survives bot restarts/redeploys (it lives on the exchange).
    // Re-enter with the SAME leverage the closed position used (read from BingX), not the
    // env default / dynamic leverage — otherwise a 100x trade re-opens at a lower leverage.
    const reLev = pos.leverage > 0 ? pos.leverage : CONFIG.leverage;
    await setLeverage(argSym, reLev);
    // Mirror the closed position's contract quantity too — a fresh CONFIG.tradeSize sizing
    // would re-open at full size even when banking a half position left over from a TP.
    const lim = await placeReentryLimit(argSym, sideAction, triggerLevel, reLev, pullbackAtr, pos.size, hadSL, tpPrice);

    // Track the order so it can be cancelled by an opposite signal / expiry, and so the
    // poller can detect the fill. positionOpenTime stays null until the limit fills.
    const s = _getSymState(argSym);
    s.positionOpenTime = null;
    s.lastAction       = sideAction;
    // Breakout fallback level: if price runs this far PAST the exit without dipping,
    // the poller cancels the limit and re-enters at market instead.
    const breakoutDist  = pullbackAtr
      ? pullbackAtr * CONFIG.commitBreakoutAtrMult
      : exitPrice * CONFIG.commitPullbackPct;
    const breakoutLevel = CONFIG.commitBreakoutAtrMult > 0
      ? (sideAction === "buy" ? exitPrice + breakoutDist : exitPrice - breakoutDist)
      : null;

    s.lastLeverage = reLev;
    s.reentry = {
      type:      "limit",
      action:    sideAction,
      orderId:   lim.orderId,
      price:     parseFloat(lim.priceStr),
      qty:       lim.qty,
      breakoutLevel,
      leverage:  reLev,
      hadSL,               // fallback market entry mirrors SL presence
      hadTrail,            // fill handler mirrors trailing presence
      tpPrice,             // inherited TP level (fallback market entry re-attaches it)
      createdAt: Date.now(),
    };
    saveSymbolState();

    logTrade(argSym, pos.side === "Buy" ? "sell" : "buy", exitPrice, "", result.orderId, "LIVE", `${source} — encaixou PnL ~$${pnl.toFixed(2)}, ordem limite re-entrada @ $${lim.priceStr}`);
    const emoji = pnl >= 0 ? "🟢" : "🔴";
    await sendTelegram(
      `${emoji} <b>Bot v3 ${argSym}</b> — Ganho encaixado (${source})\n` +
      `Posição ${pos.side} fechada @ $${formatPrice(exitPrice)} | PnL ~${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n` +
      `🔁 Ordem limite ${sideAction.toUpperCase()} ${reLev}x qty=${lim.qty} na BingX @ $${lim.priceStr} (${sideAction === "buy" ? "−" : "+"}${pullbackPctShown.toFixed(2)}% | ${pullbackSrc})\n` +
      (lim.slPrice ? `🛡 SL: $${lim.slPrice}\n` : "") +
      (lim.tpPrice ? `🎯 TP herdado: $${lim.tpPrice}\n` : "") +
      (!hadSL || !hadTrail ? `⚠️ Sem ${!hadSL && !hadTrail ? "SL nem trailing" : !hadSL ? "SL" : "trailing"} (a posição original não tinha)\n` : "") +
      (breakoutLevel ? `🚀 Fallback: entra a mercado se romper $${formatPrice(breakoutLevel)} sem dar o pullback\n` : "") +
      `Cancela com sinal contrário | expira em ${CONFIG.reentryExpiryHours}h`,
      chatId
    );
  } catch (e) {
    await sendTelegram(`❌ <b>Bot v3 ${argSym}</b> — ${source} falhou\n${e.message}`, chatId);
  }
}

// Background auto-commit — runs every 1 min when a threshold is configured.
// Banks any position whose unrealized gain reached the threshold, using the exact same
// flow as the manual /commit3 (close + pullback limit re-entry, volatility-filtered).
// Threshold: % of the position's own margin (AUTO_COMMIT_GAIN_PCT, ROI-based — scales
// with size/leverage) or fixed USD (AUTO_COMMIT_GAIN_USD) when PCT is 0.
async function checkAutoCommit() {
  const usePct = CONFIG.autoCommitGainPct > 0;
  if (!(usePct || CONFIG.autoCommitGainUSD > 0) || CONFIG.paperTrading) return;
  try {
    const positions = await getAllOpenPositions();
    for (const p of positions) {
      let threshold, label;
      if (usePct) {
        const margin = p.leverage > 0 ? (p.size * p.avgPrice) / p.leverage : 0;
        if (!(margin > 0)) continue; // leverage unknown — can't compute ROI, skip
        threshold = margin * (CONFIG.autoCommitGainPct / 100);
        label     = `${CONFIG.autoCommitGainPct}% da margem $${margin.toFixed(2)} → $${threshold.toFixed(2)}`;
      } else {
        threshold = CONFIG.autoCommitGainUSD;
        label     = `$${threshold}`;
      }
      if (p.unrealizedPnl >= threshold) {
        console.log(`\n💰 [Auto-commit] ${p.symbol}: PnL $${p.unrealizedPnl.toFixed(2)} ≥ ${label} — a encaixar`);
        await commitSymbol(p.symbol, null, "auto-commit");
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Auto-commit check: ${e.message}`);
  }
}

async function startTelegramPolling() {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) {
    console.log("⚠️  Telegram polling desativado — TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID em falta");
    return;
  }

  let offset = 0;
  console.log(`📡 Telegram polling ativo — comandos: /pnl3, /pos3 | chat_id=${chatId}`);

  // Long-poll: o Telegram segura a ligação LONGPOLL_S segundos e responde vazio se não
  // houver mensagens — expirar é NORMAL, não é erro. O abort tem de dar folga generosa
  // para a latência de rede (antes: 25s de long-poll vs abort a 30s — 5s de margem,
  // insuficiente no Railway; o abort disparava, o retry abria um getUpdates novo e o
  // Telegram podia responder 409 Conflict, criando instabilidade em cadeia).
  const LONGPOLL_S  = 20;
  const ABORT_MS    = (LONGPOLL_S + 25) * 1000;  // 45s — margem larga
  let polling = false;                            // impede ciclos de poll sobrepostos

  const poll = async () => {
    if (polling) return;                          // já há um poll em curso
    polling = true;
    let nextDelay = 500;
    try {
      // Use POST to avoid URL-encoding issues with array parameters
      const res  = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ timeout: LONGPOLL_S, offset, allowed_updates: ["message"] }),
        signal:  AbortSignal.timeout(ABORT_MS),
      });
      const data = await res.json();

      if (!data.ok) {
        // 409 = outro processo a fazer polling com o mesmo token (deploy duplicado,
        // instância local a correr...). Vale a pena gritar: os comandos ficam a saltar
        // entre instâncias e as respostas parecem perder-se.
        if (/conflict/i.test(data.description || "")) {
          console.log(`[Telegram poll] ⚠️  CONFLITO: outro processo está a fazer polling com este token — verifica se há um deploy/instância duplicada`);
        } else {
          console.log(`[Telegram poll] erro: ${data.description}`);
        }
        nextDelay = 5000;
      } else {
        for (const update of data.result || []) {
          offset = update.update_id + 1;
          const msg    = update.message;
          const text   = (msg?.text || "").trim();
          const fromId = String(msg?.chat?.id || "").trim();

          // Only respond to messages from the configured chat
          if (fromId !== chatId) continue;
          if (!text.startsWith("/")) continue;

          console.log(`[Telegram cmd] ${text}`);
          handleTelegramCommand(text, fromId).catch((e) =>
            console.log(`[Telegram cmd] erro: ${e.message}`)
          );
        }
      }
    } catch (e) {
      // Timeout/abort do long-poll: esperado quando não há mensagens — reconecta já,
      // sem ruído nos logs. Nada se perde: o offset só avança com resposta recebida.
      const benign = e.name === "TimeoutError" || /aborted|timeout/i.test(e.message || "");
      if (!benign) console.log(`[Telegram poll] ${e.message} — a tentar novamente em 5s`);
      nextDelay = benign ? 300 : 5000;
    } finally {
      polling = false;
      setTimeout(poll, nextDelay);
    }
  };

  // Register bot commands so the "/" menu appears in Telegram
  fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ commands: [
      { command: "pnl3", description: "📊 PnL do dia" },
      { command: "stats7", description: "📈 PnL últimos 7 dias (gráfico)" },
      { command: "stats30", description: "📈 PnL últimos 30 dias (gráfico)" },
      { command: "pos3", description: "📈 Posições abertas" },
      { command: "commit3", description: "💰 Listar símbolos com ganho p/ encaixar (ou /commit3 SYMBOL)" },
      { command: "close3", description: "✂️ Fechar posição (ou /close3 SYMBOL [qty] p/ parcial)" },
    ]}),
  }).catch(() => {});

  poll();
}

// ─── BingX helpers ───────────────────────────────────────────────────────────
// BingX Perpetual Futures API v2/v3 (open-api.bingx.com). Auth: HMAC-SHA256 over the
// raw "k=v&k=v&timestamp=..." parameter string, sent as &signature=..., with the API
// key in the X-BX-APIKEY header. Responses: { code: 0, msg, data }.
// Symbols use a dash (BTC-USDT); TradingView/state keep the dashless form (BTCUSDT),
// converted at the API boundary only.

function toBingxSymbol(sym) {
  const s = String(sym || "").toUpperCase();
  if (s.includes("-")) return s;
  if (s.endsWith("USDT")) return s.slice(0, -4) + "-USDT";
  if (s.endsWith("USDC")) return s.slice(0, -4) + "-USDC";
  return s;
}
function fromBingxSymbol(sym) { return String(sym || "").replace("-", ""); }

function bxSignature(paramStr) {
  return crypto.createHmac("sha256", CONFIG.bingx.secretKey).update(paramStr).digest("hex");
}

// Signed request. `params` values are signed raw and URL-encoded on the wire.
async function bxRequest(method, path, params = {}) {
  const p = { ...params, timestamp: Date.now() };
  const rawQs = Object.entries(p).map(([k, v]) => `${k}=${v}`).join("&");
  const encQs = Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const url = `${CONFIG.bingx.baseUrl}${path}?${encQs}&signature=${bxSignature(rawQs)}`;
  const res  = await fetch(url, { method, headers: { "X-BX-APIKEY": CONFIG.bingx.apiKey } });
  const data = await res.json();
  if (data.code !== undefined && data.code !== 0) throw new Error(`BingX ${path}: ${data.msg || `code ${data.code}`}`);
  return data.data;
}

// Public (unsigned) request.
async function bxPublic(path, params = {}) {
  const qs  = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const res = await fetch(`${CONFIG.bingx.baseUrl}${path}${qs ? `?${qs}` : ""}`);
  const data = await res.json();
  if (data.code !== undefined && data.code !== 0) throw new Error(`BingX ${path}: ${data.msg || `code ${data.code}`}`);
  return data.data;
}

// One-way position mode (positionSide=BOTH on every order) — set once at startup.
async function setOneWayMode() {
  try {
    await bxRequest("POST", "/openApi/swap/v1/positionSide/dual", { dualSidePosition: "false" });
    console.log("✅ BingX em modo one-way (posição única por símbolo)");
  } catch (e) {
    console.log(`⚠️  Definir modo one-way falhou (pode já estar ativo): ${e.message}`);
  }
}

async function setLeverage(symbol, lev) {
  // Clamp to the instrument maximum first (BingX rejects above-max without a parseable hint)
  try {
    const { maxLeverage } = await getInstrumentInfo(symbol);
    if (maxLeverage > 0 && lev > maxLeverage) {
      console.log(`  ⚠️  Leverage ${lev}x excede máximo ${maxLeverage}x para ${symbol} — a usar ${maxLeverage}x`);
      lev = maxLeverage;
    }
  } catch {}
  await bxRequest("POST", "/openApi/swap/v2/trade/leverage", { symbol: toBingxSymbol(symbol), side: "BOTH", leverage: lev });
}

// Contract specs. BingX exposes precisions, not tick/step sizes — converted here.
// The contracts endpoint does NOT carry leverage limits (unlike Bybit's instruments-info),
// so maxLeverage comes from the signed leverage endpoint. Both are cached: the contracts
// list is a single large payload and getInstrumentInfo is called on every order path.
const _contractsCache = { list: null, at: 0 };
const _levCache = new Map(); // symbol → { max, at }
const CONTRACTS_TTL = 10 * 60 * 1000;
const LEV_TTL       = 60 * 60 * 1000;

async function getContracts() {
  if (_contractsCache.list && Date.now() - _contractsCache.at < CONTRACTS_TTL) return _contractsCache.list;
  const data = await bxPublic("/openApi/swap/v2/quote/contracts");
  _contractsCache.list = Array.isArray(data) ? data : [];
  _contractsCache.at   = Date.now();
  return _contractsCache.list;
}

async function getMaxLeverage(symbol) {
  const bx     = toBingxSymbol(symbol);
  const cached = _levCache.get(bx);
  if (cached && Date.now() - cached.at < LEV_TTL) return cached.max;
  try {
    const d   = await bxRequest("GET", "/openApi/swap/v2/trade/leverage", { symbol: bx });
    const max = parseFloat(d?.maxLongLeverage ?? d?.maxLeverage ?? "0") || 0;
    _levCache.set(bx, { max, at: Date.now() });
    return max;
  } catch {
    return 0; // desconhecido → sem clamp (a BingX rejeita se for demais)
  }
}

async function getInstrumentInfo(symbol) {
  const bx   = toBingxSymbol(symbol);
  const inst = (await getContracts()).find(c => c.symbol === bx);
  if (!inst) return { minQty: 0.001, qtyStep: 0.001, maxLeverage: 0, tickSize: 0, minNotional: 0 };
  const qtyPrec   = parseInt(inst.quantityPrecision ?? 3);
  const pricePrec = parseInt(inst.pricePrecision    ?? 2);
  return {
    minQty:      parseFloat(inst.tradeMinQuantity ?? Math.pow(10, -qtyPrec)),
    qtyStep:     Math.pow(10, -qtyPrec),
    maxLeverage: await getMaxLeverage(symbol),   // não vem no contracts — endpoint próprio
    tickSize:    Math.pow(10, -pricePrec),
    minNotional: parseFloat(inst.tradeMinUSDT ?? "0"),  // ordem mínima em USDT
  };
}

// Keep old name as alias so existing callers still work
async function getInstrumentLotSize(symbol) {
  const { minQty, qtyStep } = await getInstrumentInfo(symbol);
  return { minQty, qtyStep };
}

// BingX kline intervals are strings ("1m","1h","4h","1d"...). TradingView sends minutes
// ("60") or D/W/M — map to the nearest supported BingX interval.
const BINGX_INTERVAL_MAP = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 120: "2h", 240: "4h", 360: "6h", 480: "8h", 720: "12h" };
const BINGX_MINUTES      = Object.keys(BINGX_INTERVAL_MAP).map(Number);

// Kept under the historical name — call sites resolve payload interval → exchange interval.
function toBingXInterval(tvInterval) {
  const str = String(tvInterval || "").toUpperCase();
  if (str === "D") return "1d";
  if (str === "W") return "1w";
  if (str === "M") return "1M";
  if (BINGX_INTERVAL_MAP[str] !== undefined) return BINGX_INTERVAL_MAP[str]; // minutos
  if (Object.values(BINGX_INTERVAL_MAP).includes(str.toLowerCase())) return str.toLowerCase(); // já no formato BingX
  const num = parseInt(str);
  if (isNaN(num)) return toBingXInterval(CONFIG.candleInterval); // fallback to config default
  const nearest = BINGX_MINUTES.reduce((a, b) => Math.abs(b - num) < Math.abs(a - num) ? b : a);
  console.log(`  ⚠️  Intervalo ${num}m não suportado pela BingX — a usar ${BINGX_INTERVAL_MAP[nearest]}`);
  return BINGX_INTERVAL_MAP[nearest];
}

// Fetch klines and normalize to the newest-first array-shape the math functions expect:
// [ [startTime, open, high, low, close, volume], ... ]
async function fetchKlinesBX(symbol, interval, limit) {
  const data = await bxPublic("/openApi/swap/v3/quote/klines", {
    symbol: toBingxSymbol(symbol), interval: toBingXInterval(interval), limit,
  });
  const list = (Array.isArray(data) ? data : [])
    .map(c => [parseInt(c.time), c.open, c.high, c.low, c.close, c.volume])
    .sort((a, b) => b[0] - a[0]); // newest first
  return list;
}

// Fetch current best bid and ask prices for a symbol.
async function fetchBidAsk(symbol) {
  const t = await bxPublic("/openApi/swap/v2/quote/bookTicker", { symbol: toBingxSymbol(symbol) });
  const book = t?.book_ticker || t; // some responses nest under book_ticker
  const bid = parseFloat(book?.bidPrice ?? book?.bid_price);
  const ask = parseFloat(book?.askPrice ?? book?.ask_price);
  if (!bid || !ask) throw new Error(`fetchBidAsk: sem dados de ticker para ${symbol}`);
  return { bid, ask };
}

// Query the status of an open/recent order.
// Returns a BingX-style status string ("New", "Filled", "PartiallyFilled", "Cancelled")
// so existing call sites keep working, or null on error.
async function getOrderStatus(symbol, orderId) {
  try {
    const data = await bxRequest("GET", "/openApi/swap/v2/trade/order", { symbol: toBingxSymbol(symbol), orderId });
    const st = data?.order?.status || data?.status;
    switch (st) {
      case "NEW": case "PENDING": return "New";
      case "FILLED": return "Filled";
      case "PARTIALLY_FILLED": return "PartiallyFilled";
      case "CANCELLED": case "CANCELED": return "Cancelled";
      case "EXPIRED": return "Deactivated";
      default: return st ?? null;
    }
  } catch {
    return null;
  }
}

// Cancel an open order by orderId.
async function cancelOrder(symbol, orderId) {
  try {
    return await bxRequest("DELETE", "/openApi/swap/v2/trade/order", { symbol: toBingxSymbol(symbol), orderId });
  } catch (e) {
    console.log(`  ⚠️  Cancelamento de ordem falhou: ${e.message}`);
    return null;
  }
}

// Fetch candles from BingX and compute simple ATR(period).
// interval: TV/config interval — converted internally.
// If TradingView already sends "atr" in the payload, this function is skipped entirely.
async function fetchATR(symbol, interval) {
  const limit = CONFIG.atrPeriod + 1; // need one extra candle for the first prev-close
  const candles = await fetchKlinesBX(symbol, interval, limit);
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
  const candles = await fetchKlinesBX(symbol, interval, limit);
  if (!candles || candles.length < period)
    throw new Error(`Trend EMA: só ${candles?.length ?? 0} velas (precisa de ${period})`);

  // newest-first — reverse to oldest-first for sequential EMA
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
  const candles   = await fetchKlinesBX(symbol, interval, limit);
  if (!candles || candles.length < CONFIG.atrPeriod + 2)
    throw new Error(`ATRAvg50: só ${candles?.length ?? 0} velas`);
  // newest-first. Compute TR for each consecutive pair.
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

// Fetch best bid/ask and return spread as % of mid price.
async function fetchSpreadPct(symbol) {
  const { bid, ask } = await fetchBidAsk(symbol);
  const mid = (bid + ask) / 2;
  return { bid, ask, spreadPct: (ask - bid) / mid };
}

// Returns { currentVol, avgVol, ratio } for volume filter.
// currentVol = volume of the most recent completed bar; avgVol = mean of last `periods` bars.
async function fetchVolumeRatio(symbol, interval, periods) {
  const limit   = periods + 1; // +1 so candles[0] (possibly open bar) is excluded
  const candles = await fetchKlinesBX(symbol, interval, limit);
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
          `⏰ <b>Bot v3 ${sym}</b> — Posição fechada por timeout\n` +
          `Aberta há ${elapsedH}h | PnL: $${pnl.toFixed(2)}\n` +
          `(PnL dentro de $${CONFIG.positionTimeoutPnlMin} a $${CONFIG.positionTimeoutPnlMax})`
        );
      }
    } catch (e) {
      console.log(`  ⚠️  Timeout check ${sym}: ${e.message}`);
    }
  }
}

// Background re-entry check — runs every 1 min. Handles two kinds of armed watch:
//   • "breakout" (auto, only when TRAILING_REENTRY_ENABLED=true): a position closed at
//     breakeven/profit by the trailing-stop arms a watch; re-enters when price breaks
//     back past the exit level (trend continuation).
//   • "pullback" (from the manual /commit3 command): re-enters when price retraces to a
//     target below/above the exit (buy the dip / sell the rip).
// Both: at most once per REENTRY_COOLDOWN_MS, expire after REENTRY_EXPIRY_HOURS, and are
// cancelled by an opposite-direction signal (see handleWebhook).
async function checkTrailingReentries() {
  const now = Date.now();

  for (const [sym, state] of Object.entries(symbolState)) {
    try {
      // ── 1) Auto-detect trailing-stop closure → arm breakout watch ─────────
      if (CONFIG.trailingReentryEnabled && state.positionOpenTime) {
        const pos = await getOpenPosition(sym);
        if (!pos) {
          state.positionOpenTime = null;
          const last = await getLastClosedPnl(sym);
          if (last && parseFloat(last.closedPnl) >= 0 && state.lastAction) {
            state.reentry = {
              type:            "breakout",
              action:          state.lastAction,
              level:           parseFloat(last.avgExitPrice),
              createdAt:       now,
              lastAttemptTime: 0,
            };
            console.log(`  🔁 ${sym}: posição fechada por trailing-stop @ $${last.avgExitPrice} (PnL $${parseFloat(last.closedPnl).toFixed(2)}) — a vigiar re-entrada ${state.lastAction.toUpperCase()} (breakout)`);
          }
          saveSymbolState();
        }
      }

      // ── 2) Check armed re-entry watches ──────────────────────────────────
      if (state.reentry) {
        const r = state.reentry;
        const kind = r.type || "breakout";

        // ── 2a) BingX limit re-entry (/commit3) — poll status ───────────────
        if (kind === "limit") {
          const expiryMs = CONFIG.reentryExpiryHours * 3_600_000;
          let status = null;
          try { status = await getOrderStatus(sym, r.orderId); } catch {}

          if (status === "Filled") {
            console.log(`  ✅ ${sym}: ordem limite de re-entrada encheu @ $${r.price}`);
            state.positionOpenTime = now;   // hand the position to timeout/trailing tracking
            state.lastAction       = r.action;
            if (r.leverage > 0) state.lastLeverage = r.leverage; // keep leverage for future re-entries
            delete state.reentry;
            saveSymbolState();
            try {
              // Mirror the original position: no trailing if it didn't have one (r.hadTrail
              // undefined = legacy watch → keep the old always-trailing behaviour).
              if (r.hadTrail !== false && CONFIG.tradeMode === "futures") {
                let atr = null; try { atr = await fetchATR(sym, state.lastInterval || CONFIG.candleInterval); } catch {}
                await setTrailingStop(sym, r.action, r.price, atr);
              } else if (r.hadTrail === false) {
                console.log(`  ℹ️  ${sym}: sem trailing na re-entrada (posição original não tinha)`);
              }
            } catch (e) { console.log(`  ⚠️  Trailing pós-fill ${sym}: ${e.message}`); }
            await sendTelegram(`🔁 <b>Bot v3 ${sym}</b> — Re-entrada ${r.action.toUpperCase()} encheu @ $${formatPrice(r.price)} (ordem limite)`);
            continue;
          }
          if (status === "Cancelled" || status === "Rejected" || status === "Deactivated") {
            console.log(`  ✖ ${sym}: ordem limite de re-entrada ${status} — watch removida`);
            delete state.reentry;
            saveSymbolState();
            continue;
          }

          // Breakout fallback: price resumed the original direction without ever giving
          // the pullback — cancel the resting limit and enter at market (same qty/leverage)
          // so the continuation isn't lost. Respects the trading-hours window.
          if (status === "New" && r.breakoutLevel && r.qty) {
            const cur = await fetchCurrentPrice(sym);
            const broke = cur > 0 && (r.action === "buy" ? cur >= r.breakoutLevel : cur <= r.breakoutLevel);
            const hoursOk = CONFIG.tradeHoursStart === null || CONFIG.tradeHoursEnd === null ||
              isInTimeWindow(new Date().getUTCHours(), CONFIG.tradeHoursStart, CONFIG.tradeHoursEnd);
            if (broke && hoursOk) {
              console.log(`  🚀 ${sym}: rompeu $${formatPrice(r.breakoutLevel)} sem dar pullback — a cancelar limite e entrar a mercado`);
              await cancelOrder(sym, r.orderId);
              try {
                const side = r.action === "buy" ? "Buy" : "Sell";
                const { tickSize } = await getInstrumentInfo(sym);
                let atr = null;
                try { atr = await fetchATR(sym, state.lastInterval || CONFIG.candleInterval); } catch {}
                // Mirror SL presence of the original position (undefined = legacy → attach)
                let stopLoss = null;
                if (r.hadSL !== false) {
                  const slDist = atr ? atr * CONFIG.atrMultiplier : cur * CONFIG.stopLossPct;
                  stopLoss = roundToTick(r.action === "buy" ? cur - slDist : cur + slDist, tickSize);
                }
                // Inherited TP — only if still on the correct side of the current price
                const tpOk = r.tpPrice > 0 && (r.action === "buy" ? r.tpPrice > cur : r.tpPrice < cur);
                const takeProfit = tpOk ? roundToTick(r.tpPrice, tickSize) : null;
                const mktParams = {
                  symbol: toBingxSymbol(sym), side: side.toUpperCase(), positionSide: "BOTH",
                  type: "MARKET", quantity: String(r.qty),
                };
                if (stopLoss)   mktParams.stopLoss   = JSON.stringify({ type: "STOP_MARKET", stopPrice: parseFloat(stopLoss), workingType: "CONTRACT_PRICE" });
                if (takeProfit) mktParams.takeProfit = JSON.stringify({ type: "TAKE_PROFIT_MARKET", stopPrice: parseFloat(takeProfit), workingType: "CONTRACT_PRICE" });
                const dM = await bxRequest("POST", "/openApi/swap/v2/trade/order", mktParams);
                state.positionOpenTime = now;
                state.lastAction       = r.action;
                delete state.reentry;
                saveSymbolState();
                if (r.hadTrail !== false && CONFIG.tradeMode === "futures") await setTrailingStop(sym, r.action, cur, atr);
                logTrade(sym, r.action, cur, "", dM?.order?.orderId ?? dM?.orderId, "LIVE", `Re-entrada fallback breakout @ $${formatPrice(r.breakoutLevel)} (limite não encheu)`);
                await sendTelegram(
                  `🚀 <b>Bot v3 ${sym}</b> — Re-entrada ${r.action.toUpperCase()} a mercado (fallback)\n` +
                  `Preço fugiu sem dar pullback — rompeu $${formatPrice(r.breakoutLevel)}\n` +
                  `Entrada @ ~$${formatPrice(cur)} qty=${r.qty} | SL: ${stopLoss ? `$${stopLoss}` : "— (original não tinha)"}${takeProfit ? ` | TP herdado: $${takeProfit}` : ""}`
                );
              } catch (e) {
                console.log(`  ❌ Fallback breakout ${sym} falhou: ${e.message}`);
                delete state.reentry;
                saveSymbolState();
                await sendTelegram(`❌ <b>Bot v3 ${sym}</b> — Fallback breakout falhou\n${e.message}`);
              }
              continue;
            }
          }

          if (now - r.createdAt > expiryMs) {
            console.log(`  ⌛ ${sym}: re-entrada limite expirou (${CONFIG.reentryExpiryHours}h) — a cancelar ordem`);
            try { await cancelOrder(sym, r.orderId); } catch {}
            delete state.reentry;
            saveSymbolState();
          }
          continue; // limit watches are fully handled here
        }

        // ── 2b) Software watches (breakout / legacy pullback) ───────────────
        const expiryMs = CONFIG.reentryExpiryHours * 3_600_000;
        if (now - r.createdAt > expiryMs) {
          console.log(`  ⌛ ${sym}: watch de re-entrada (${kind}) expirou (${CONFIG.reentryExpiryHours}h sem gatilho)`);
          delete state.reentry;
          saveSymbolState();
          continue;
        }
        if (now - r.lastAttemptTime < CONFIG.reentryCooldownMs) continue;

        const currentPrice = await fetchCurrentPrice(sym);
        if (!currentPrice) continue;

        // Trigger: breakout = price resumes the original direction past the exit level;
        //          pullback = price retraces to the dip/rip target.
        const triggered = kind === "pullback"
          ? (r.action === "buy" ? currentPrice <= r.triggerLevel : currentPrice >= r.triggerLevel)
          : (r.action === "buy" ? currentPrice >  r.level        : currentPrice <  r.level);
        if (!triggered) continue;

        const openPos = await getOpenPosition(sym);
        if (openPos) { delete state.reentry; saveSymbolState(); continue; } // already has a position — drop watch

        r.lastAttemptTime = now;
        saveSymbolState();
        const refLevel = kind === "pullback" ? r.triggerLevel : r.level;
        await executeReentry(sym, r.action, currentPrice, refLevel, kind);
      }
    } catch (e) {
      console.log(`  ⚠️  Reentry check ${sym}: ${e.message}`);
    }
  }
}

// Executes a re-entry: same direction as the position just closed, now that the trigger
// (breakout past exit, or pullback to the dip/rip) fired. Applies the same
// time/volatility/fee filters as a normal signal, but skips trend/volume/R:R — those
// validate TradingView's own signal quality, not this price-confirmed re-entry.
async function executeReentry(symbol, action, priceNum, refLevel, kind = "breakout") {
  const kindLabel = kind === "pullback" ? "pullback/dip" : "breakout";
  console.log(`\n🔁 [Re-entrada ${kindLabel}] ${symbol} ${action.toUpperCase()} @ $${priceNum} (nível ref $${refLevel})`);

  if (CONFIG.tradeHoursStart !== null && CONFIG.tradeHoursEnd !== null) {
    const hourUTC = new Date().getUTCHours();
    if (!isInTimeWindow(hourUTC, CONFIG.tradeHoursStart, CONFIG.tradeHoursEnd)) {
      console.log(`  ⏰ Fora do horário de trading — re-entrada ignorada`);
      return;
    }
  }

  try {
    // Use the same candle interval as the original entry (payload interval), so the
    // re-entry's ATR-based SL/trailing width matches the strategy's timeframe.
    const st         = _getSymState(symbol);
    const reInterval = st.lastInterval || CONFIG.candleInterval;

    let resolvedAtr = null;
    try { resolvedAtr = await fetchATR(symbol, reInterval); }
    catch (e) { console.log(`  ⚠️  ATR fetch falhou: ${e.message} — SL fixo será usado`); }

    // Mirror the leverage the original (now-closed) position used, stored at its entry.
    // Falls back to the env default if unknown.
    const reLev = st.lastLeverage > 0 ? st.lastLeverage : CONFIG.leverage;

    const effectiveSlPct = resolvedAtr ? (resolvedAtr * CONFIG.atrMultiplier) / priceNum : CONFIG.stopLossPct;

    if (CONFIG.maxSlPct > 0 && effectiveSlPct > CONFIG.maxSlPct) {
      console.log(`  ⏸ Re-entrada ignorada — SL ${(effectiveSlPct * 100).toFixed(2)}% > limite ${(CONFIG.maxSlPct * 100).toFixed(1)}%`);
      return;
    }

    if (CONFIG.feeViabilityThreshold > 0 && resolvedAtr) {
      const notional      = CONFIG.tradeSize * reLev;
      const feesRoundTrip = notional * 0.00055 * 2;
      const expectedTp1   = notional * effectiveSlPct * 0.5;
      if (expectedTp1 < feesRoundTrip * CONFIG.feeViabilityThreshold) {
        console.log(`  ⏸ Re-entrada ignorada — TP1 esperado ($${expectedTp1.toFixed(2)}) < taxas × ${CONFIG.feeViabilityThreshold}`);
        return;
      }
    }

    await setLeverage(symbol, reLev);
    const order = await placeOrder(symbol, action, priceNum, reLev, resolvedAtr, null);
    console.log(`  ✅ RE-ENTRADA — ${order.orderId} | ${reLev}x | ${order.filledAs === "maker" ? "maker 0.02%" : "taker 0.055%"}`);
    recordSignalPlaced(symbol, action, priceNum, reLev, reInterval);

    if (CONFIG.tradeMode === "futures") {
      await setTrailingStop(symbol, action, priceNum, resolvedAtr);
    }

    logTrade(symbol, action, priceNum, order.tradeSize, order.orderId, "LIVE", `Re-entrada ${kind} @ $${refLevel}`);
    await sendTelegram(
      `🔁 <b>Bot v3 ${symbol}</b> — Re-entrada ${action.toUpperCase()} (${kindLabel})\n` +
      `Preço: $${priceNum} | Nível ref: $${refLevel}\n` +
      `SL: $${order.slPrice} (${(order.slPct * 100).toFixed(2)}%)`
    );
  } catch (e) {
    console.log(`  ❌ Re-entrada falhou: ${e.message}`);
    await sendTelegram(`❌ <b>Bot v3 ${symbol}</b> — Re-entrada falhou\n${e.message}`);
  }
}

// Places a resting GTC limit order at a specific price (the /commit3 dip/rip level),
// with an ATR-based SL attached (activates on fill). Returns { orderId, slPrice, priceStr, qty }.
// Unlike placeOrder's chase-limit→market flow, this never falls back to market — it must
// rest in the book until price reaches the level (or it's cancelled).
// qtyOverride: mirror the closed position's contract quantity (e.g. after a TP half-close)
// instead of sizing a fresh CONFIG.tradeSize × lev position.
// attachSL: false mirrors an original position that had no SL — the re-entry gets none either.
// tpPrice: TP level inherited from the original position (attached only if still valid
// relative to the limit price — e.g. above it for a buy).
async function placeReentryLimit(symbol, action, limitPrice, lev, atr, qtyOverride = null, attachSL = true, tpPrice = null) {
  const side = action === "buy" ? "Buy" : "Sell";
  const { minQty, qtyStep, maxLeverage, tickSize } = await getInstrumentInfo(symbol);
  if (maxLeverage > 0 && lev > maxLeverage) lev = maxLeverage;

  const priceStr = roundToTick(limitPrice, tickSize);
  const priceNum = parseFloat(priceStr);

  // SL: ATR-based, falling back to the fixed STOP_LOSS_PCT — never rest in the book
  // without a stop UNLESS the original position deliberately had none (attachSL=false).
  let slPrice = null;
  if (attachSL) {
    const slDist = atr ? atr * CONFIG.atrMultiplier : priceNum * CONFIG.stopLossPct;
    slPrice = roundToTick(action === "buy" ? priceNum - slDist : priceNum + slDist, tickSize);
  }

  // TP: inherit the original position's target if it's on the correct side of the entry
  const tpValid = tpPrice > 0 && (action === "buy" ? tpPrice > priceNum : tpPrice < priceNum);
  const tpStr   = tpValid ? roundToTick(tpPrice, tickSize) : null;

  let qty;
  if (qtyOverride > 0) {
    const decimals = (qtyStep.toString().split(".")[1] || "").length;
    qty = Math.max(Math.floor(qtyOverride / qtyStep) * qtyStep, minQty).toFixed(decimals);
  } else {
    qty = calcQty(CONFIG.tradeSize, lev, priceNum, minQty, qtyStep);
  }
  // BingX: SL/TP anexados como objetos JSON no próprio pedido de ordem
  const params = {
    symbol: toBingxSymbol(symbol), side: side.toUpperCase(), positionSide: "BOTH",
    type: "LIMIT", price: priceStr, quantity: qty, timeInForce: "GTC",
  };
  if (slPrice) params.stopLoss   = JSON.stringify({ type: "STOP_MARKET", stopPrice: parseFloat(slPrice), workingType: "CONTRACT_PRICE" });
  if (tpStr)   params.takeProfit = JSON.stringify({ type: "TAKE_PROFIT_MARKET", stopPrice: parseFloat(tpStr), workingType: "CONTRACT_PRICE" });
  const data = await bxRequest("POST", "/openApi/swap/v2/trade/order", params);
  const orderId = data?.order?.orderId ?? data?.orderId;
  console.log(`  📌 Ordem limite de re-entrada @ $${priceStr} | qty=${qty} | SL=${slPrice ?? "—"} | TP=${tpStr ?? "—"} | ${orderId}`);
  return { orderId, slPrice, tpPrice: tpStr, priceStr, qty };
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

// atrValue: if provided (from payload or pre-fetched), skips the BingX candle fetch.
// Returns { orderId, slPrice, slPct, slDistance, atrUsed, tradeSize, filledAs }
//   filledAs: "maker" (limit filled) | "taker" (market fallback)
// slOverride: absolute SL price from payload (e.g. TradingView indicator level).
//   When provided, skips ATR calculation and uses this price directly.
async function placeOrder(symbol, action, price, lev, atrValue = null, slOverride = null) {
  const side = action === "buy" ? "Buy" : "Sell";

  let slPct, slDistance, stopLoss, atr = atrValue;

  if (slOverride) {
    // ── SL from payload (TradingView structural level) ───────────────────
    stopLoss   = parseFloat(slOverride);
    slDistance = Math.abs(price - parseFloat(slOverride));
    slPct      = slDistance / price;
    console.log(`  SL do payload (TradingView): distância $${slDistance.toFixed(4)} (${(slPct * 100).toFixed(3)}%)`);
  } else {
    // ── ATR-based SL (fallback) ───────────────────────────────────────────
    if (!atr) {
      try {
        atr = await fetchATR(symbol, CONFIG.candleInterval);
      } catch (e) {
        console.log(`  ⚠️  ATR fetch falhou (${e.message}) — a usar SL fixo ${CONFIG.stopLossPct * 100}%`);
      }
    }

    if (atr) {
      slDistance = atr * CONFIG.atrMultiplier;
      slPct      = slDistance / price;
      console.log(`  ATR=$${atr.toFixed(4)} | SL=${CONFIG.atrMultiplier}×ATR=$${slDistance.toFixed(4)} (${(slPct * 100).toFixed(3)}%)`);
    } else {
      slPct      = CONFIG.stopLossPct;
      slDistance = price * slPct;
      console.log(`  SL fixo: ${(slPct * 100).toFixed(2)}%`);
    }

    stopLoss = action === "buy"
      ? price - slDistance
      : price + slDistance;
  }
  // stopLoss is rounded to the instrument tick size after getInstrumentInfo below.
  // TP is managed by TradingView webhooks (tp/tp2) — no native BingX TP set
  // to avoid conflict with the half-close + break-even logic

  // ── Position sizing ───────────────────────────────────────────────────────
  const tradeSize = CONFIG.riskPerTradeUSD > 0
    ? calcRiskBasedTradeSize(CONFIG.riskPerTradeUSD, lev, slPct, CONFIG.tradeSize)
    : CONFIG.tradeSize;
  const tradeSizeMode = CONFIG.riskPerTradeUSD > 0
    ? `risk-based ($${CONFIG.riskPerTradeUSD} risco → $${tradeSize} margem, perda máx $${(CONFIG.riskPerTradeUSD).toFixed(2)})`
    : `fixo ($${tradeSize})`;

  const { minQty, qtyStep, maxLeverage, tickSize, minNotional } = await getInstrumentInfo(symbol);
  // Round SL to the instrument tick size (was toFixed(2) — wrong for sub-$1 / fine-tick assets)
  stopLoss = roundToTick(stopLoss, tickSize);
  console.log(`  SL: $${stopLoss}${tickSize > 0 ? ` (tick ${tickSize})` : ""}`);
  // Cap leverage to instrument maximum (avoids "gt maxLeverage" error from BingX)
  if (maxLeverage > 0 && lev > maxLeverage) {
    console.log(`  ⚠️  Leverage ${lev}x capado a ${maxLeverage}x (máx para ${symbol})`);
    lev = maxLeverage;
  }
  const quantity = calcQty(tradeSize, lev, price, minQty, qtyStep);
  console.log(`  Size: ${tradeSizeMode} | Qty: ${quantity} (${lev}x ÷ $${price.toFixed(2)}, min=${minQty}, step=${qtyStep})`);

  // BingX rejects orders below the instrument's minimum notional (tradeMinUSDT) — fail
  // with a clear message instead of an opaque exchange error.
  const notional = parseFloat(quantity) * price;
  if (minNotional > 0 && notional < minNotional) {
    throw new Error(`Ordem abaixo do mínimo da BingX: $${notional.toFixed(2)} < $${minNotional} (${symbol}) — aumenta MAX_TRADE_SIZE_USD ou a leverage`);
  }

  // ── Chase Limit → Market fallback ────────────────────────────────────────
  // 1st attempt: Limit order at current bid (buy) or ask (sell) → maker fee 0.02%
  // If not filled within CHASE_LIMIT_TIMEOUT_MS → cancel → Market order → taker fee 0.055%
  let orderId  = null;
  let filledAs = "taker";

  // BingX: SL anexado como objeto JSON no pedido de ordem
  const slParam = JSON.stringify({ type: "STOP_MARKET", stopPrice: parseFloat(stopLoss), workingType: "CONTRACT_PRICE" });

  if (CONFIG.chaseLimitEnabled && CONFIG.tradeMode === "futures") {
    try {
      const { bid, ask } = await fetchBidAsk(symbol);
      const limitPrice   = roundToTick(action === "buy" ? bid : ask, tickSize);
      console.log(`  🎯 Chase Limit @ $${limitPrice} (${action === "buy" ? "bid" : "ask"}) — aguarda ${CONFIG.chaseLimitTimeoutMs}ms`);

      let limitOrderId = null;
      try {
        const d1 = await bxRequest("POST", "/openApi/swap/v2/trade/order", {
          symbol: toBingxSymbol(symbol), side: side.toUpperCase(), positionSide: "BOTH",
          type: "LIMIT", price: limitPrice, quantity, timeInForce: "GTC", stopLoss: slParam,
        });
        limitOrderId = d1?.order?.orderId ?? d1?.orderId;
      } catch (e) {
        console.log(`  ⚠️  Limit rejeitada pela BingX (${e.message}) — a usar Market`);
      }

      if (limitOrderId) {
        // Wait for potential fill
        await new Promise(r => setTimeout(r, CONFIG.chaseLimitTimeoutMs));
        const status = await getOrderStatus(symbol, limitOrderId);
        console.log(`  Status após ${CONFIG.chaseLimitTimeoutMs}ms: ${status ?? "desconhecido"}`);

        if (status === "Filled") {
          orderId  = limitOrderId;
          filledAs = "maker";
          console.log(`  ✅ LIMIT FILLED — taxa maker`);
        } else if (status === "PartiallyFilled") {
          // Accept partial fill, cancel remaining to avoid open limit sitting in book
          await cancelOrder(symbol, limitOrderId);
          orderId  = limitOrderId;
          filledAs = "maker";
          console.log(`  ✅ LIMIT PARCIALMENTE FILLED — restante cancelado | taxa maker`);
        } else {
          // Not filled → cancel and fall through to market
          console.log(`  ⚠️  Limit não encheu (${status ?? "unknown"}) — a cancelar → Market`);
          await cancelOrder(symbol, limitOrderId);
        }
      }
    } catch (e) {
      console.log(`  ⚠️  Chase Limit erro (${e.message}) — a usar Market`);
    }
  }

  // ── Market order (fallback ou direto se chase limit desativado) ───────────
  if (!orderId) {
    const d2 = await bxRequest("POST", "/openApi/swap/v2/trade/order", {
      symbol: toBingxSymbol(symbol), side: side.toUpperCase(), positionSide: "BOTH",
      type: "MARKET", quantity, stopLoss: slParam,
    });
    orderId  = d2?.order?.orderId ?? d2?.orderId;
    filledAs = "taker";
    console.log(`  ✅ MARKET ORDER — taxa taker`);
  }

  return { orderId, slPrice: stopLoss, slPct, slDistance, atrUsed: atr, tradeSize, filledAs };
}

async function fetchCurrentPrice(symbol) {
  try {
    const data = await bxPublic("/openApi/swap/v1/ticker/price", { symbol: toBingxSymbol(symbol) });
    return parseFloat(data?.price || "0") || null;
  } catch (e) {
    console.log(`  ⚠️  fetchCurrentPrice falhou para ${symbol}: ${e.message}`);
    return null;
  }
}

// Open conditional (SL/TP/trailing) orders attached to a symbol's position.
// BingX keeps protections as separate reduce orders, not position attributes — this
// reconstructs the BingX-style view (stopLoss/takeProfit/trailing on the position).
async function getProtectionOrders(symbol) {
  try {
    const data = await bxRequest("GET", "/openApi/swap/v2/trade/openOrders", { symbol: toBingxSymbol(symbol) });
    const orders = data?.orders || [];
    const sl    = orders.find(o => o.type === "STOP_MARKET" || o.type === "STOP");
    const tp    = orders.find(o => o.type === "TAKE_PROFIT_MARKET" || o.type === "TAKE_PROFIT");
    const trail = orders.find(o => o.type === "TRAILING_STOP_MARKET");
    return {
      slPrice:      sl    ? parseFloat(sl.stopPrice || sl.price || "0") : 0,
      slOrderId:    sl?.orderId    ?? null,
      tpPrice:      tp    ? parseFloat(tp.stopPrice || tp.price || "0") : 0,
      tpOrderId:    tp?.orderId    ?? null,
      trailActive:  trail ? 1 : 0,
      trailOrderId: trail?.orderId ?? null,
    };
  } catch {
    return { slPrice: 0, slOrderId: null, tpPrice: 0, tpOrderId: null, trailActive: 0, trailOrderId: null };
  }
}

async function getOpenPosition(symbol) {
  const data = await bxRequest("GET", "/openApi/swap/v2/user/positions", { symbol: toBingxSymbol(symbol) });
  const position = (Array.isArray(data) ? data : []).find(p => Math.abs(parseFloat(p.positionAmt || "0")) > 0);
  if (!position) return null;
  const size = Math.abs(parseFloat(position.positionAmt));
  const prot = await getProtectionOrders(symbol);
  return {
    side:           position.positionSide === "SHORT" || parseFloat(position.positionAmt) < 0 ? "Sell" : "Buy",
    size,
    stopLoss:       prot.slPrice,                                     // from the open STOP_MARKET order
    avgPrice:       parseFloat(position.avgPrice        || "0"),
    unrealizedPnl:  parseFloat(position.unrealizedProfit || position.unrealisedProfit || "0"),
    leverage:       parseFloat(position.leverage        || "0"),      // so a re-entry can mirror the original leverage
    trailingStop:   prot.trailActive,                                 // so a re-entry can mirror SL/trailing presence
    takeProfit:     prot.tpPrice,                                     // so a re-entry can inherit the TP level
    slOrderId:      prot.slOrderId,
    tpOrderId:      prot.tpOrderId,
    trailOrderId:   prot.trailOrderId,
  };
}

async function closePosition(symbol, position) {
  const closeSide = position.side === "Buy" ? "SELL" : "BUY";
  const data = await bxRequest("POST", "/openApi/swap/v2/trade/order", {
    symbol: toBingxSymbol(symbol), side: closeSide, positionSide: "BOTH",
    type: "MARKET", quantity: String(position.size), reduceOnly: "true",
  });
  return { orderId: data?.order?.orderId ?? data?.orderId };
}

// Reduce-only market close of `qty` contracts. qty is floored to the instrument's
// qtyStep and capped at the position size. Used by closeHalfPosition (TP) and by
// /close3 SYMBOL <qty> (manual partial close).
async function closePartialPosition(symbol, position, qty) {
  const { qtyStep } = await getInstrumentLotSize(symbol);
  const decimals    = (qtyStep.toString().split(".")[1] || "").length;
  // Floor to qtyStep and never exceed the open size
  const wanted   = Math.min(parseFloat(qty), position.size);
  const closeQty = (Math.floor(wanted / qtyStep) * qtyStep).toFixed(decimals);
  if (parseFloat(closeQty) <= 0)
    throw new Error(`Quantidade ${qty} inválida — mínimo ${qtyStep} (posição: ${position.size})`);

  const closeSide = position.side === "Buy" ? "SELL" : "BUY";
  const data = await bxRequest("POST", "/openApi/swap/v2/trade/order", {
    symbol: toBingxSymbol(symbol), side: closeSide, positionSide: "BOTH",
    type: "MARKET", quantity: closeQty, reduceOnly: "true",
  });
  return { orderId: data?.order?.orderId ?? data?.orderId, closedQty: closeQty, remainingQty: (position.size - parseFloat(closeQty)).toFixed(decimals) };
}

async function closeHalfPosition(symbol, position) {
  return closePartialPosition(symbol, position, position.size / 2);
}

// Move the position SL to a new price. On BingX the SL is a separate STOP_MARKET order:
// cancel the existing one (if any) and place a new closePosition stop at the new level.
async function setBreakEvenStop(symbol, entryPrice) {
  const { tickSize } = await getInstrumentInfo(symbol);
  const slPrice = roundToTick(parseFloat(entryPrice), tickSize);
  const pos = await getOpenPosition(symbol);
  if (!pos) throw new Error("Sem posição aberta para mover o SL");
  if (pos.slOrderId) await cancelOrder(symbol, pos.slOrderId);
  const closeSide = pos.side === "Buy" ? "SELL" : "BUY";
  await bxRequest("POST", "/openApi/swap/v2/trade/order", {
    symbol: toBingxSymbol(symbol), side: closeSide, positionSide: "BOTH",
    type: "STOP_MARKET", stopPrice: slPrice, closePosition: "true", workingType: "CONTRACT_PRICE",
  });
}

// Income records in [startTime, endTime] — the building block for the daily/period PnL
// views. Fetched WITHOUT an incomeType filter on purpose: on BingX a liquidation is
// recorded as INSURANCE_CLEAR, not REALIZED_PNL, so filtering by REALIZED_PNL alone
// reported a profit on a day that was actually a loss. Fees and funding are separate
// records too, and Bybit's closedPnl (what v2 reports) is net of fees — so summing all
// trading-related types is also what keeps the two bots comparable.
// Only account movements (deposits/withdrawals/transfers) are excluded.
const NON_PNL_INCOME = ["TRANSFER", "DEPOSIT", "WITHDRAW"];

async function fetchIncomeRange(startTime, endTime) {
  const data = await bxRequest("GET", "/openApi/swap/v2/user/income", {
    startTime, endTime, limit: 1000,
  });
  return (Array.isArray(data) ? data : [])
    .filter(r => !NON_PNL_INCOME.some(t => String(r.incomeType || "").toUpperCase().includes(t)))
    .map(r => ({
      symbol:      fromBingxSymbol(r.symbol),
      closedPnl:   r.income,
      incomeType:  r.incomeType,
      updatedTime: String(r.time),
    }));
}

// Returns today's total realised PnL (negative = loss).
// Pass symbol to get per-pair PnL; omit for all symbols combined.
async function getDailyClosedPnl(symbol = null) {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const list = await fetchIncomeRange(todayMidnight.getTime(), Date.now());
  return list
    .filter(r => !symbol || r.symbol === symbol.toUpperCase())
    .reduce((sum, item) => sum + parseFloat(item.closedPnl || 0), 0);
}

// Returns the most recently closed position record for a symbol (or null), shaped like
// BingX's closed-pnl entry ({ closedPnl, avgExitPrice, updatedTime }) so the re-entry
// and cooldown logic stay unchanged. Uses BingX position history.
// (positionHistory returns an empty list on this account type, so the closing order
// itself is the source: a filled order carrying a non-zero `profit` is a close, and it
// gives both the realized PnL and the exit price the re-entry logic needs.)
async function getLastClosedPnl(symbol) {
  try {
    const now  = Date.now();
    const data = await bxRequest("GET", "/openApi/swap/v2/trade/allOrders", {
      symbol: toBingxSymbol(symbol), startTime: now - 7 * 86_400_000, endTime: now, limit: 100,
    });
    const orders = data?.orders || (Array.isArray(data) ? data : []);
    const closes = orders.filter(o =>
      String(o.status).toUpperCase() === "FILLED" &&
      parseFloat(o.executedQty || "0") > 0 &&
      parseFloat(o.profit || "0") !== 0
    );
    if (!closes.length) return null;
    const last = closes.sort((a, b) => parseInt(b.updateTime || b.time || 0) - parseInt(a.updateTime || a.time || 0))[0];
    // profit is gross; subtract the closing commission so the sign matches Bybit's closedPnl
    const net = parseFloat(last.profit || "0") - Math.abs(parseFloat(last.commission || "0"));
    return {
      closedPnl:    String(net),
      avgExitPrice: last.avgPrice ?? "0",
      updatedTime:  String(last.updateTime ?? last.time ?? now),
    };
  } catch (e) {
    console.log(`  ⚠️  getLastClosedPnl ${symbol}: ${e.message}`);
    return null;
  }
}

// BingX API keys don't auto-expire on a fixed 3-month schedule like BingX's — this
// check is a no-op kept for config compatibility.
async function checkApiKeyExpiry() {
  console.log("🔑 Verificação de expiração da API key: n/a na BingX");
}

// Format a price/distance value with enough decimal places to avoid rounding to zero.
// For low-price assets (e.g. HANAUSDT @ $0.0335), toFixed(2) would produce "0.00".
function formatPrice(value) {
  if (!value || value <= 0) return "0";
  if (value >= 1) return value.toFixed(2);
  const decimals = Math.max(2, -Math.floor(Math.log10(value)) + 2);
  return value.toFixed(decimals);
}

// Round a price (or price-distance) to the instrument's tick size and format with
// matching decimals. BingX rejects SL / activePrice values that aren't exact multiples
// of tickSize — toFixed(2) silently corrupts them for sub-$1 or fine-tick assets.
// Falls back to formatPrice (decimal-count heuristic) when tickSize is unknown.
function roundToTick(price, tickSize) {
  if (!price || price <= 0) return "0";
  if (!tickSize || tickSize <= 0) return formatPrice(price);
  const decimals = (tickSize.toString().split(".")[1] || "").length;
  const rounded  = Math.round(price / tickSize) * tickSize;
  return rounded.toFixed(decimals);
}

// atr: if provided, trailing distance = atr × ATR_MULTIPLIER (same buffer as the SL).
// Fallback: entryPrice × TRAILING_STOP_PCT (legacy fixed %).
// Stable coins (STABLE_SYMBOLS) use wider STABLE_TRAILING_STOP_PCT.
// Activation price = entry ± trailingDistance, so that when BingX activates the
// trail (stop = activePrice − distance), the initial stop lands at breakeven —
// the trailing stop can never close the position at a loss, only at breakeven or profit.
async function setTrailingStop(symbol, action, entryPrice, atr = null) {
  const isStable = CONFIG.stableSymbols.includes(symbol.toUpperCase());
  const trailingStopPct      = isStable ? CONFIG.stableTrailingStopPct      : CONFIG.trailingStopPct;

  // Trailing distance uses TRAILING_ATR_MULT if set, else falls back to ATR_MULTIPLIER (= SL distance)
  const trailMult = CONFIG.trailingAtrMult > 0 ? CONFIG.trailingAtrMult : CONFIG.atrMultiplier;
  const rawDistance  = atr
    ? atr * trailMult
    : entryPrice * trailingStopPct;
  const { tickSize } = await getInstrumentInfo(symbol);
  const trailingDistance = roundToTick(rawDistance, tickSize);
  const distanceNum = parseFloat(trailingDistance);

  // Guard: if distance rounds to zero BingX will reject the request
  if (distanceNum === 0) {
    console.log(`  ⚠️  Trailing stop ignorado — distância calculada é zero (ATR demasiado pequeno)`);
    return;
  }

  // Activation price = entry ± trailingDistance (breakeven once trailing activates)
  const activePriceNum = action === "buy"
    ? entryPrice + distanceNum
    : entryPrice - distanceNum;

  // Check current price — if it already passed activePriceNum, BingX rejects activePrice.
  // In that case omit it: trailing activates immediately (stop = currentPrice − distance ≥ entry).
  const currentPrice = await fetchCurrentPrice(symbol);
  const alreadyActivated = currentPrice > 0 && (
    action === "buy"  ? currentPrice >= activePriceNum :
                        currentPrice <= activePriceNum
  );

  const src = atr ? `${trailMult}×ATR($${parseFloat(atr).toFixed(4)})` : `${(trailingStopPct * 100).toFixed(1)}% fixo${isStable ? " (stable)" : ""}`;
  if (alreadyActivated) {
    console.log(`  Trailing stop: distance=$${trailingDistance} (${src}) | activa imediatamente (preço já passou $${formatPrice(activePriceNum)})`);
  } else {
    console.log(`  Trailing stop: distance=$${trailingDistance} (${src}) | activa @ $${formatPrice(activePriceNum)} (breakeven garantido)`);
  }

  // BingX: o trailing é uma ordem TRAILING_STOP_MARKET reduce-only com callback em
  // RÁCIO (priceRate = distância/entrada) e activationPrice opcional. Com a ativação
  // em entrada ± distância, o stop inicial ao ativar ≈ breakeven — mesma garantia.
  try {
    const pos = await getOpenPosition(symbol);
    if (!pos) { console.log("  ⚠️  Trailing ignorado — posição não encontrada"); return; }
    // Cancel a previous trailing order, if any (replace semantics like BingX's)
    if (pos.trailOrderId) await cancelOrder(symbol, pos.trailOrderId);
    const priceRate = Math.min(0.99, Math.max(0.001, distanceNum / entryPrice));
    const params = {
      symbol: toBingxSymbol(symbol),
      side: action === "buy" ? "SELL" : "BUY",
      positionSide: "BOTH",
      type: "TRAILING_STOP_MARKET",
      quantity: String(pos.size),
      priceRate: priceRate.toFixed(4),
      reduceOnly: "true",
    };
    if (!alreadyActivated) params.activationPrice = roundToTick(activePriceNum, tickSize);
    await bxRequest("POST", "/openApi/swap/v2/trade/order", params);
  } catch (e) {
    console.log(`  ⚠️  Trailing stop falhou: ${e.message}`);
  }
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

// Download the trade log CSV. Protected by the webhook secret (same as /webhook):
//   GET /trades?secret=YOUR_WEBHOOK_SECRET
app.get("/trades", (req, res) => {
  if (CONFIG.webhookSecret && req.query.secret !== CONFIG.webhookSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!existsSync(LOG_FILE)) {
    return res.status(404).json({ error: "Nenhum trade registado ainda (CSV não existe)" });
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="webhook-trades.csv"');
  res.send(readFileSync(LOG_FILE, "utf8"));
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

  const { secret, action, symbol, price, leverage, entry_price, atr: payloadAtr, interval: payloadInterval, sl: payloadSl } = body;

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
    console.log("  ℹ️  No price in payload — fetching live price from BingX...");
    priceNum = await fetchCurrentPrice(sym);
    if (!priceNum) {
      console.log("  ❌ Não foi possível obter preço live — sinal ignorado");
      return;
    }
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

  // Cancel a pending re-entry on a new signal. Opposite signals cancel any watch; a resting
  // BingX limit re-entry (from /commit3) is cancelled by ANY new signal (same or opposite)
  // so a fresh entry can't leave an orphan limit order behind. Done here (not only via
  // recordSignalPlaced) so it happens even if the new order is later blocked by a filter.
  if (actionLower !== "tp") {
    const stCancel = symbolState[sym];
    const rc = stCancel?.reentry;
    if (rc && (rc.action !== actionLower || rc.type === "limit")) {
      if (rc.type === "limit" && rc.orderId) {
        try { await cancelOrder(sym, rc.orderId); console.log(`  ✖ ${sym}: ordem limite de re-entrada ${rc.orderId} cancelada na BingX`); }
        catch (e) { console.log(`  ⚠️  ${sym}: cancelar ordem de re-entrada falhou: ${e.message}`); }
      } else {
        console.log(`  ✖ ${sym}: watch de re-entrada (${rc.type || "breakout"}) cancelada — sinal ${actionLower.toUpperCase()}`);
      }
      delete stCancel.reentry;
      saveSymbolState();
    }
  }

  // ── Take-profit: close half the active position ───────────────────────────
  if (actionLower === "tp") {
    console.log(`  🎯 TP signal — a fechar metade da posição em ${sym}...`);
    if (CONFIG.paperTrading) {
      console.log(`  📋 PAPER TP — nenhuma ordem enviada`);
      await sendTelegram(`📋 <b>Bot v3 ${sym}</b> — PAPER TP\nFecharia metade da posição`);
      return;
    }
    try {
      const openPos = await getOpenPosition(sym);
      if (!openPos) {
        console.log(`  ⚠️  Nenhuma posição aberta em ${sym} — TP ignorado`);
        await sendTelegram(`⚠️ <b>Bot v3 ${sym}</b> — TP ignorado\nNenhuma posição aberta`);
        return;
      }
      console.log(`  Posição: ${openPos.side} qty=${openPos.size} | PnL não realizado: ${openPos.unrealizedPnl >= 0 ? "+" : ""}$${openPos.unrealizedPnl.toFixed(2)}`);

      // TP loss guard: skip if unrealized PnL is below the configured minimum
      if (CONFIG.minTpPnlUSD !== 0 && openPos.unrealizedPnl < CONFIG.minTpPnlUSD) {
        const msg = `⏸ TP ignorado — PnL não realizado $${openPos.unrealizedPnl.toFixed(2)} < mínimo $${CONFIG.minTpPnlUSD} (posição em perda)`;
        console.log(`  ${msg}`);
        await sendTelegram(
          `⏸ <b>Bot v3 ${sym}</b> — TP ignorado\n` +
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

      // Entry price — use BingX's avgPrice (always reliable) with payload entry_price as fallback
      const entryNum = (openPos.avgPrice > 0 ? openPos.avgPrice : null)
                    ?? (parseFloat(entry_price) > 0 ? parseFloat(entry_price) : null);
      if (entryNum) console.log(`  Entry price: $${entryNum} (${openPos.avgPrice > 0 ? "BingX avgPrice" : "payload entry_price"})`);

      // PnL da operação: (exit - entry) × qty fechada
      const closedQtyNum = parseFloat(result.closedQty);
      let opPnl = null;
      if (entryNum && closedQtyNum > 0) {
        opPnl = openPos.side === "Buy"
          ? (priceNum - entryNum) * closedQtyNum
          : (entryNum - priceNum) * closedQtyNum;
        console.log(`  💰 PnL operação: ${opPnl >= 0 ? "+" : ""}$${opPnl.toFixed(2)} (entrada $${entryNum} → saída $${priceNum} × ${closedQtyNum})`);
      }

      // PnL do dia via BingX closed-pnl
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
            newSl = (currentSl + priceNum) / 2;  // tick-rounded inside setBreakEvenStop
            console.log(`  ✅ SL progressivo (TP2+): $${currentSl} → $${formatPrice(newSl)} (meio entre $${currentSl} e $${priceNum})`);
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
            newSl = beSl;  // tick-rounded inside setBreakEvenStop
            const bufLabel = beBuffer > 0
              ? ` (entry $${entryNum} ${openPos.side === "Buy" ? "-" : "+"} ${CONFIG.breakEvenBufferAtr}×ATR=$${beBuffer.toFixed(2)})`
              : "";
            console.log(`  ✅ SL break-even (TP1): → $${formatPrice(newSl)}${bufLabel}`);
          }

          // Validate SL is on the correct side of current price before submitting.
          // For a Buy  position: SL must be < current price (stop loss is below).
          // For a Sell position: SL must be > current price (stop loss is above).
          // If the position is in loss at TP time the computed break-even can end up
          // on the wrong side, causing BingX to reject the order.
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
        `🎯 <b>Take-Profit Bot v3</b> — ${sym}\n` +
        `Posição ${openPos.side} | Fechado: ${result.closedQty} | Resta: ${result.remainingQty}\n` +
        (newSl !== null ? `🛡 Novo SL: $${formatPrice(newSl)}\n` : "") +
        (opPnl !== null ? `💰 PnL operação: ${opPnl >= 0 ? "+" : ""}$${opPnl.toFixed(2)}\n` : "") +
        (dailyPnl !== null ? `📊 PnL hoje (${sym}): $${dailyPnl.toFixed(2)}\n` : "")
      );
      return;
    } catch (err) {
      console.log(`  ❌ TP ERROR — ${err.message}`);
      await sendTelegram(`❌ <b>Bot v3 ${sym}</b> — Erro no TP\n${err.message}`);
      return;
    }
  }

  if (CONFIG.paperTrading) {
    const paperId = `PAPER-${Date.now()}`;
    console.log(`  📋 PAPER TRADE — ${actionLower.toUpperCase()} $${CONFIG.tradeSize} ${sym}`);
    logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, paperId, "PAPER", "Signal received");
    await sendTelegram(`📋 <b>Bot v3 ${sym}</b> — PAPER ${actionLower.toUpperCase()}\nPreço: $${priceNum} | Size: $${CONFIG.tradeSize}\nSL: ${CONFIG.stopLossPct*100}%`);
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
        await sendTelegram(`🛑 <b>Bot v3 ${sym}</b> — Bloqueado\n${msg}`);
        return;
      }

      if (CONFIG.maxDailyLossTotal > 0 && totalPnl < -CONFIG.maxDailyLossTotal) {
        const msg = `🛑 Limite de perda diária global atingido: $${totalPnl.toFixed(2)} (limite: -$${CONFIG.maxDailyLossTotal})`;
        console.log(`  ${msg}`);
        await sendTelegram(`🛑 <b>Bot v3</b> — Bloqueado (todos os pares)\n${msg}`);
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
      const cooldownCheck = await checkCooldownAndSlLimit(sym, actionLower, !!openPos);
      if (cooldownCheck.blocked) {
        console.log(`  ${cooldownCheck.reason}`);
        logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, "", "BLOCKED", cooldownCheck.reason);
        await sendTelegram(`${cooldownCheck.reason}\n<b>Bot v3 ${sym}</b> — sinal ${actionLower.toUpperCase()} ignorado`);
        return;
      }

      // ── Duplicate signal guard ──────────────────────────────────────────────
      if (openPos && openPos.side.toLowerCase() === actionLower) {
        console.log(`  ⚠️  Already ${openPos.side} (qty=${openPos.size}) — skipping duplicate signal`);
        logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, "", "SKIPPED", `Already ${openPos.side}`);
        await sendTelegram(`⏭ <b>Bot v3 ${sym}</b> — Sinal ignorado\nJá tem posição ${openPos.side} aberta (qty=${openPos.size})`);
        return;
      }

      // ── Trend filter ────────────────────────────────────────────────────────
      if (CONFIG.trendMarginPct > 0) {
        try {
          const trendInt = toBingXInterval(CONFIG.trendInterval);
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
              `🚫 <b>Bot v3 ${sym}</b> — ${actionLower.toUpperCase()} bloqueado\n` +
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
        // Reversal loss guard — two tiers:
        //   loss > MAX_REVERSAL_HARD_CAP_USD → force-close the loser (cut the loss),
        //     skip the new entry. Caps tail risk under Cross margin.
        //   MAX_REVERSAL_LOSS_USD < loss ≤ hard cap → hold for recovery (no reversal).
        //   loss ≤ MAX_REVERSAL_LOSS_USD → reverse normally (falls through below).
        const loss = -openPos.unrealizedPnl; // positive = magnitude of the unrealized loss

        if (CONFIG.maxReversalHardCapUSD > 0 && loss > CONFIG.maxReversalHardCapUSD) {
          console.log(`  🛑 ${sym}: ${openPos.side} com perda $${openPos.unrealizedPnl.toFixed(2)} > teto $${CONFIG.maxReversalHardCapUSD} — a fechar (cortar perda), sem nova entrada`);
          const closeResult = await closePosition(sym, openPos);
          console.log(`  ✅ POSITION CLOSED (hard cap) — ${closeResult.orderId}`);
          logTrade(sym, openPos.side.toLowerCase() === "buy" ? "sell" : "buy", priceNum, CONFIG.tradeSize, closeResult.orderId, "LIVE", `Hard-cap close: perda $${openPos.unrealizedPnl.toFixed(2)} > teto $${CONFIG.maxReversalHardCapUSD}`);
          await sendTelegram(
            `🛑 <b>Bot v3 ${sym}</b> — Perdedor fechado (teto de perda)\n` +
            `${openPos.side} PnL $${openPos.unrealizedPnl.toFixed(2)} > teto -$${CONFIG.maxReversalHardCapUSD}\n` +
            `Perda cortada — nova entrada ${actionLower.toUpperCase()} ignorada`
          );
          return;
        }

        if (CONFIG.maxReversalLossUSD > 0 && loss > CONFIG.maxReversalLossUSD) {
          const pnlDisplay = `$${openPos.unrealizedPnl.toFixed(2)}`;
          const msg = `⏸ Reversão bloqueada — ${openPos.side} tem PnL não realizado ${pnlDisplay} (limite: -$${CONFIG.maxReversalLossUSD})\nA aguardar recuperação antes de reverter para ${actionLower.toUpperCase()}`;
          console.log(`  ${msg}`);
          await sendTelegram(`⏸ <b>Bot v3 ${sym}</b> — Reversão bloqueada\n${msg}`);
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
    const candleInterval = toBingXInterval(payloadInterval || CONFIG.candleInterval);
    if (payloadInterval) console.log(`  Intervalo do payload: ${payloadInterval} → BingX: ${candleInterval}m`);

    // Resolve ATR — payload first, then fetch from BingX candles using signal's own interval
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
          await sendTelegram(`⏸ <b>Bot v3 ${sym}</b> — Sinal ignorado\n${msg}\nVol atual: ${currentVol.toFixed(0)} | Média(${CONFIG.volumeFilterPeriods}): ${avgVol.toFixed(0)}`);
          return;
        }
        console.log(`  ✅ Filtro volume OK: ${ratio.toFixed(2)}× média (mínimo ${CONFIG.volumeFilterMult}×)`);
      } catch (e) {
        console.log(`  ⚠️  Filtro volume falhou: ${e.message} — a continuar`);
      }
    }

    // Effective SL % — use payload SL price if provided, otherwise ATR-derived.
    // All pre-entry filters (fee viability, volatility, R:R) use this same value
    // so they stay consistent with the SL that will actually be placed.
    const slNum = parseFloat(payloadSl) > 0 ? parseFloat(payloadSl) : null;
    const effectiveSlPct = slNum
      ? Math.abs(priceNum - slNum) / priceNum
      : resolvedAtr
        ? (resolvedAtr * CONFIG.atrMultiplier) / priceNum
        : CONFIG.stopLossPct;
    const slSource = slNum ? `payload ($${slNum})` : resolvedAtr ? `ATR×${CONFIG.atrMultiplier}` : "fixo";
    if (slNum) console.log(`  SL do payload: $${slNum} | distância ${(effectiveSlPct * 100).toFixed(3)}%`);

    // ── Fee viability filter ──────────────────────────────────────────────────
    // Skip trade if expected TP1 profit (1:1 RR, half position) < round-trip fees × threshold.
    // Uses worst-case taker fee (0.055%) for both sides — if chase limit fires, we're even better off.
    if (CONFIG.feeViabilityThreshold > 0 && (slNum || resolvedAtr)) {
      const notional        = CONFIG.tradeSize * effectiveLev;
      const feesRoundTrip   = notional * 0.00055 * 2;
      const expectedTp1     = notional * effectiveSlPct * 0.5;
      const minRequired     = feesRoundTrip * CONFIG.feeViabilityThreshold;
      if (expectedTp1 < minRequired) {
        const msg = `⏸ Trade ignorado — TP1 esperado ($${expectedTp1.toFixed(2)}) < taxas ($${feesRoundTrip.toFixed(2)}) × ${CONFIG.feeViabilityThreshold}`;
        console.log(`  ${msg}`);
        await sendTelegram(`⏸ <b>Bot v3 ${sym}</b> — Sinal ignorado\n${msg}\nSL (${slSource}): ${(effectiveSlPct*100).toFixed(3)}% demasiado pequeno para cobrir taxas`);
        return;
      }
      console.log(`  ✅ Viabilidade taxas OK: TP1 $${expectedTp1.toFixed(2)} ≥ taxas $${feesRoundTrip.toFixed(2)} × ${CONFIG.feeViabilityThreshold}`);
    }

    // ── Volatility filter ─────────────────────────────────────────────────────
    if (CONFIG.maxSlPct > 0 && (slNum || resolvedAtr)) {
      if (effectiveSlPct > CONFIG.maxSlPct) {
        const slPctStr    = (effectiveSlPct * 100).toFixed(2);
        const limitPctStr = (CONFIG.maxSlPct * 100).toFixed(1);
        const msg = `⏸ Sinal ignorado — SL demasiado largo: ${slPctStr}% > limite ${limitPctStr}%`;
        console.log(`  ${msg}`);
        await sendTelegram(
          `⏸ <b>Bot v3 ${sym}</b> — Sinal ignorado\n` +
          `SL (${slSource}) demasiado largo\n` +
          `SL: ${slPctStr}% | Limite: ${limitPctStr}%`
        );
        return;
      }
      console.log(`  ✅ Filtro volatilidade OK: SL ${(effectiveSlPct * 100).toFixed(2)}% ≤ ${(CONFIG.maxSlPct * 100).toFixed(1)}%`);
    }

    // ── Minimum R:R filter ────────────────────────────────────────────────────
    if (CONFIG.minRR > 0 && (slNum || resolvedAtr)) {
      const impliedTpPct = effectiveSlPct * CONFIG.minRR;
      if (CONFIG.maxTpPct > 0 && impliedTpPct > CONFIG.maxTpPct) {
        const msg = `⏸ TP implícito ${(impliedTpPct * 100).toFixed(2)}% (SL ${(effectiveSlPct * 100).toFixed(2)}% × ${CONFIG.minRR}) > máx ${(CONFIG.maxTpPct * 100).toFixed(2)}% — sinal ignorado`;
        console.log(`  ${msg}`);
        await sendTelegram(
          `⏸ <b>Bot v3 ${sym}</b> — Sinal ignorado\n` +
          `${msg}\n` +
          `SL (${slSource}): ${(effectiveSlPct * 100).toFixed(2)}%\n` +
          `Para R:R≥${CONFIG.minRR} o TradingView teria de alvo ≥${(impliedTpPct * 100).toFixed(2)}% — demasiado`
        );
        return;
      }
      console.log(`  ✅ R:R OK: SL ${(effectiveSlPct * 100).toFixed(2)}% → TP implícito ${(impliedTpPct * 100).toFixed(2)}% (×${CONFIG.minRR})${CONFIG.maxTpPct > 0 ? ` ≤ máx ${(CONFIG.maxTpPct * 100).toFixed(2)}%` : ""}`);
    }

    // ── Spread check ─────────────────────────────────────────────────────────
    if (CONFIG.maxSpreadPct > 0) {
      try {
        const { bid, ask, spreadPct } = await fetchSpreadPct(sym);
        if (spreadPct > CONFIG.maxSpreadPct) {
          const msg = `⏸ Spread demasiado largo: ${(spreadPct * 100).toFixed(4)}% (máx ${(CONFIG.maxSpreadPct * 100).toFixed(4)}%) — sinal ignorado`;
          console.log(`  ${msg}`);
          await sendTelegram(`⏸ <b>Bot v3 ${sym}</b> — Sinal ignorado\n${msg}\nBid: $${bid} | Ask: $${ask}`);
          return;
        }
        console.log(`  ✅ Spread OK: ${(spreadPct * 100).toFixed(4)}% ≤ ${(CONFIG.maxSpreadPct * 100).toFixed(4)}% (bid $${bid} / ask $${ask})`);
      } catch (e) {
        console.log(`  ⚠️  Spread check falhou: ${e.message} — a continuar`);
      }
    }

    const order = await placeOrder(sym, actionLower, priceNum, dynLev, resolvedAtr, slNum);
    const feeType = order.filledAs === "maker" ? "maker 0.02% 💚" : "taker 0.055%";
    console.log(`  ✅ ORDER PLACED — ${order.orderId} | ${feeType}`);
    recordSignalPlaced(sym, actionLower, priceNum, effectiveLev, candleInterval); // store leverage+interval for re-entries

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
      `✅ <b>Bot v3 ${sym}</b> — LIVE ${actionLower.toUpperCase()}\n` +
      `Preço: $${priceNum} | Size: $${order.tradeSize ?? CONFIG.tradeSize}\n` +
      `SL: ${slLabel} | TP: via TradingView\n` +
      `Taxa: ${feeLabel}\n` +
      (dailyPnlLine ? `${dailyPnlLine}\n` : "")
    );

  } catch (err) {
    console.log(`  ❌ ERROR — ${err.message}`);
    logTrade(sym, actionLower, priceNum, CONFIG.tradeSize, "", "ERROR", err.message);
    await sendTelegram(`❌ <b>Bot v3 ${sym}</b> — Erro na ordem\n${err.message}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

initCsv();
loadSymbolState();
app.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradingView Webhook Bot v3 — BingX");
  console.log(`  Port     : ${PORT}`);
  console.log(`  Data dir : ${DATA_DIR}${DATA_DIR === "." ? " (efémero — define DATA_DIR p/ Volume Railway)" : " (persistente)"} | estado: ${SYMBOL_STATE_FILE}`);
  console.log(`  Mode     : ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Leverage : ${CONFIG.leverage}x`);
  console.log(`  Trade    : $${CONFIG.tradeSize} per signal${CONFIG.riskPerTradeUSD > 0 ? ` (risk-based $${CONFIG.riskPerTradeUSD})` : ""}`);
  console.log(`  SL       : ATR(${CONFIG.atrPeriod}, ${CONFIG.candleInterval}m) × ${CONFIG.atrMultiplier} | fallback ${CONFIG.stopLossPct * 100}%`);
  console.log(`  Trailing : ${CONFIG.trailingAtrMult > 0 ? `${CONFIG.trailingAtrMult}×ATR (distinto do SL)` : `${CONFIG.atrMultiplier}×ATR (= SL, TRAILING_ATR_MULT para separar)`} | breakeven garantido`);
  console.log(`  Vol.filter: ${CONFIG.maxSlPct > 0 ? `skip se SL > ${(CONFIG.maxSlPct * 100).toFixed(1)}%` : "desativado (MAX_SL_PCT=0)"}`);
  console.log(`  Tendência : ${CONFIG.trendMarginPct > 0 ? `EMA${CONFIG.trendEmaPeriod}(${CONFIG.trendInterval}m) | margem ${(CONFIG.trendMarginPct * 100).toFixed(1)}%` : "desativado (TREND_MARGIN_PCT=0)"}`);
  console.log(`  Chase Limit: ${CONFIG.chaseLimitEnabled ? `ativo — timeout ${CONFIG.chaseLimitTimeoutMs}ms → fallback Market` : "desativado (sempre Market)"}`);
  console.log(`  BE buffer : ${CONFIG.breakEvenBufferAtr > 0 ? `${CONFIG.breakEvenBufferAtr}×ATR abaixo/acima da entrada` : "desativado (SL exato na entrada)"}`);
  console.log(`  Fee filter: ${CONFIG.feeViabilityThreshold > 0 ? `skip se TP1 < taxas × ${CONFIG.feeViabilityThreshold}` : "desativado"}`);
  console.log(`  R:R mín   : ${CONFIG.minRR > 0 ? `${CONFIG.minRR} — TP implícito=SL×${CONFIG.minRR}${CONFIG.maxTpPct > 0 ? ` | bloq. se TP implícito > ${(CONFIG.maxTpPct*100).toFixed(2)}%` : " | sem cap (MAX_TP_PCT=0)"}` : "desativado (MIN_RR=0)"}`);
  console.log(`  TP guard  : ${CONFIG.minTpPnlUSD !== 0 ? `skip TP se PnL < $${CONFIG.minTpPnlUSD}` : "desativado — TP sempre executa (MIN_TP_PNL_USD para ativar)"}`);
  console.log(`  Reversão  : ${CONFIG.maxReversalLossUSD > 0 ? `segura se perda > $${CONFIG.maxReversalLossUSD}` : "sempre permitida (MAX_REVERSAL_LOSS_USD=0)"}${CONFIG.maxReversalHardCapUSD > 0 ? ` | fecha sempre se perda > $${CONFIG.maxReversalHardCapUSD} (teto)` : " | sem teto (MAX_REVERSAL_HARD_CAP_USD=0)"}`);
  console.log(`  Lev.dinâm : ${CONFIG.dynamicLeverage ? "ativo (ATR>avg→75% | ATR>1.5×avg→50%)" : "desativado (DYNAMIC_LEVERAGE=true para ativar)"}`);
  console.log(`  Horário   : ${CONFIG.tradeHoursStart !== null ? `${String(CONFIG.tradeHoursStart).padStart(2,"0")}:00–${String(CONFIG.tradeHoursEnd).padStart(2,"0")}:00 UTC` : "24/7 (TRADE_HOURS_START/END para limitar)"}`);
  console.log(`  Volume    : ${CONFIG.volumeFilterMult > 0 ? `skip se vol < ${CONFIG.volumeFilterMult}× média(${CONFIG.volumeFilterPeriods})` : "desativado (VOLUME_FILTER_MULT para ativar)"}`);
  console.log(`  Timeout   : ${CONFIG.positionTimeoutHours > 0 ? `fecha após ${CONFIG.positionTimeoutHours}h se PnL entre $${CONFIG.positionTimeoutPnlMin} e $${CONFIG.positionTimeoutPnlMax}` : "desativado (POSITION_TIMEOUT_HOURS para ativar)"}`);
  console.log(`  Spread    : ${CONFIG.maxSpreadPct > 0 ? `skip se spread > ${(CONFIG.maxSpreadPct * 100).toFixed(4)}%` : "desativado (MAX_SPREAD_PCT para ativar)"}`);
  console.log(`  Cooldown  : ${CONFIG.cooldownAfterSlMs > 0 ? `${CONFIG.cooldownAfterSlMs / 60000}min após SL inferido` : "desativado"}${CONFIG.maxSlPerSymbol > 0 ? ` | bloqueia após ${CONFIG.maxSlPerSymbol} SL/dia` : ""}`);
  console.log(`  Stable    : ${CONFIG.stableSymbols.length > 0 ? `${CONFIG.stableSymbols.join(", ")} | trailing ${CONFIG.stableTrailingStopPct * 100}%` : "desativado (STABLE_SYMBOLS vazio)"}`);
  console.log(`  Re-entrada: ${CONFIG.trailingReentryEnabled ? `breakout 1×/${CONFIG.reentryCooldownMs / 3600000}h após trailing-stop, expira em ${CONFIG.reentryExpiryHours}h` : "breakout desativado (TRAILING_REENTRY_ENABLED=true)"}`);
  console.log(`  /commit3  : menu lista ganhos > $${CONFIG.commitMinGainUSD} | ordem LIMITE na BingX @ pullback ${CONFIG.commitPullbackAtrMult}×ATR (fallback ${(CONFIG.commitPullbackPct * 100).toFixed(2)}%) | expira em ${CONFIG.reentryExpiryHours}h${CONFIG.commitBreakoutAtrMult > 0 ? ` | fallback mercado se romper ${CONFIG.commitBreakoutAtrMult}×ATR` : ""}`);
  console.log(`  Auto-commit: ${CONFIG.autoCommitGainPct > 0 ? `encaixa quando PnL ≥ ${CONFIG.autoCommitGainPct}% da margem (verifica 1min)` : CONFIG.autoCommitGainUSD > 0 ? `encaixa quando PnL ≥ $${CONFIG.autoCommitGainUSD} (verifica 1min)` : "desativado (AUTO_COMMIT_GAIN_PCT ou _USD para ativar)"}`);
  console.log(`  Endpoint : POST /webhook`);
  console.log(`  Payload  : { "secret":"...", "action":"buy|sell", "symbol":"BTCUSDT", "price":75000, "sl":74000 (opcional), "atr":0.5 (opcional) }`);
  console.log("═══════════════════════════════════════════════════════════");

  // Start background position timeout checker (every 5 min)
  if (CONFIG.positionTimeoutHours > 0) {
    setInterval(checkPositionTimeouts, 5 * 60 * 1000);
    console.log(`⏱  Position timeout checker ativo — verifica a cada 5min`);
  }

  // Start background re-entry checker (every 1 min). Always on so manual /commit3 pullback
  // watches are serviced; breakout auto-detection is still gated by TRAILING_REENTRY_ENABLED.
  setInterval(checkTrailingReentries, 60 * 1000);
  console.log(`🔁 Re-entry checker ativo (1min) — breakout: ${CONFIG.trailingReentryEnabled ? "on" : "off"} | pullback /commit3: on`);

  // Start background auto-commit checker (every 1 min)
  if (CONFIG.autoCommitGainPct > 0 || CONFIG.autoCommitGainUSD > 0) {
    setInterval(checkAutoCommit, 60 * 1000);
    console.log(`💰 Auto-commit ativo — encaixa quando PnL ≥ ${CONFIG.autoCommitGainPct > 0 ? `${CONFIG.autoCommitGainPct}% da margem da posição` : `$${CONFIG.autoCommitGainUSD}`}`);
  }

  // BingX: garantir modo one-way (uma posição por símbolo, positionSide=BOTH).
  // O bot assume esta semântica em todo o lado (reversões, reduceOnly, fechos parciais).
  setOneWayMode();

  // Start Telegram command polling
  startTelegramPolling();
});
