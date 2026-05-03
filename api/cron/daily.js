// Daily morning recap to Alvin + Ken via WhatsApp.
// Schedule (.github/workflows/daily-cron.yml): 9am HKT = 01:00 UTC.
// HKT (UTC+8) has no DST so a single UTC schedule is correct year-round.
//
// Auth: Authorization: Bearer <CRON_SECRET>. Same secret as the other cron.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const W = "6gYeaEULEH6f6Pu1SpcgnENUonKegjGa8f6GWwreyqQt";
const TRACKING_START = Math.floor(new Date('2026-04-28T00:00:00Z').getTime() / 1000);
const BUDGET_WEEKLY = 125;
const NOTIF_KEY = 'alvin:notifications';
const SETTINGS_KEY = 'alvin:settings';

const TOKEN_SYMBOLS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'wETH',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'wBTC',
};
const num = v => typeof v === 'string' ? parseFloat(v) || 0 : (v || 0);
const pnlStr = v => v > 0 ? `+$${v.toFixed(2)}` : v < 0 ? `-$${Math.abs(v).toFixed(2)}` : '$0';
function shellSafe(s) { return String(s).replace(/\$(\d)/g, '$​$1'); }
// CallMeBot's Apache front-end runs mod_security; a rule blocks any newline
// followed by an HTTP method name (GET/POST/etc) as a request-smuggling
// defence. Insert a zero-width space between newline and any leading HTTP
// method word so the pattern doesn't match.
function wafSafe(s) { return String(s).replace(/(\n)(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE|Get|Post|Put|Delete|Head|Options|Patch|Connect|Trace)\b/g, '$1​$2'); }

async function kvCmd(args) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return null;
    return (await r.json()).result;
  } catch { return null; }
}
async function fetchKvHash(key) {
  const arr = await kvCmd(['HGETALL', key]);
  const out = {};
  if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) {
    try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch {}
  }
  return out;
}
async function shouldSkip(dedupKey, ttlSec) {
  if (!dedupKey) return false;
  const v = await kvCmd(['HGET', NOTIF_KEY, dedupKey]);
  if (!v) return false;
  const at = parseInt(v, 10);
  return !isNaN(at) && (Date.now() - at) < ttlSec * 1000;
}
async function markSent(dedupKey) {
  if (dedupKey) await kvCmd(['HSET', NOTIF_KEY, dedupKey, String(Date.now())]);
}
async function sendWA(to, message) {
  const phoneVar = to === 'alvin' ? 'WHATSAPP_ALVIN_PHONE' : 'WHATSAPP_KEN_PHONE';
  const keyVar = to === 'alvin' ? 'WHATSAPP_ALVIN_KEY' : 'WHATSAPP_KEN_KEY';
  const phone = process.env[phoneVar], key = process.env[keyVar];
  if (!phone || !key) return { ok: false };
  const text = wafSafe(shellSafe(String(message).slice(0, 1500).trim()));
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url);
    const body = await r.text();
    return { ok: r.ok && /(sent|queued|success)/i.test(body), body: body.slice(0, 200) };
  } catch (e) { return { ok: false, error: e?.message }; }
}

async function fetchPositions() {
  try {
    const r = await fetch(`https://perps-api.jup.ag/v1/positions?walletAddress=${W}`);
    return r.ok ? ((await r.json())?.dataList || []) : [];
  } catch { return []; }
}
async function fetchTradesSince(afterSec) {
  try {
    const r = await fetch(`https://perps-api.jup.ag/v1/trades?walletAddress=${W}&createdAtAfter=${afterSec}&start=0&end=2000`);
    return r.ok ? ((await r.json())?.dataList || []) : [];
  } catch { return []; }
}

function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString('en-AU', { timeZone: 'Asia/Hong_Kong', day: 'numeric', month: 'short', weekday: 'short' });
}
function getWeekStart(nowSec) {
  // Start of current Mon-Sun week in UTC, floored at TRACKING_START
  const d = new Date(nowSec * 1000);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
  return Math.max(Math.floor(d.getTime() / 1000), TRACKING_START);
}

function composeDaily({ trades, positions, settings, dayStart, dayEnd, weekStart }) {
  const inWindow = trades.filter(t => t.createdTime >= dayStart && t.createdTime < dayEnd);
  const closes = inWindow.filter(t => t.action === 'Decrease');
  const opens = inWindow.filter(t => t.action === 'Increase');
  const wins = closes.filter(t => num(t.pnl) > 0).length;
  const losses = closes.filter(t => num(t.pnl) < 0).length;
  const liqs = closes.filter(t => t.orderType === 'Liquidation').length;
  const yesterdayPnl = closes.reduce((s, t) => s + num(t.pnl), 0);
  const totalFees = inWindow.reduce((s, t) => s + num(t.fee), 0);

  // Week-to-date P&L (Mon..now) bounded by TRACKING_START
  const weekTrades = trades.filter(t => t.createdTime >= weekStart && t.action === 'Decrease');
  const wtdPnl = weekTrades.reduce((s, t) => s + num(t.pnl), 0);
  const wtdLiqs = weekTrades.filter(t => t.orderType === 'Liquidation').length;
  const overBudget = wtdPnl <= -BUDGET_WEEKLY;

  // Open positions snapshot
  const openSummary = positions.map(p => {
    const pnl = num(p.pnlAfterFeesUsd ?? p.pnl);
    const collat = num(p.collateralUsd);
    const ratio = collat > 0 ? (pnl / collat).toFixed(2) + 'x' : '?';
    const market = p.positionName || TOKEN_SYMBOLS[p.marketMint] || '?';
    const side = (p.side || '').toUpperCase();
    const liq = num(p.liquidationPrice), mark = num(p.markPrice ?? p.currentPrice);
    let liqBit = '';
    if (liq > 0 && mark > 0) {
      const dist = side === 'LONG' ? ((mark - liq) / mark) * 100 : ((liq - mark) / mark) * 100;
      if (dist > 0) liqBit = ` · liq ${dist.toFixed(1)}% away${dist < 5 ? ' ⚠' : ''}`;
    }
    return `· ${side} ${market} · ${pnlStr(pnl)} (${ratio})${liqBit}`;
  }).join('\n');

  const regime = settings.regime === 'trend' ? 'Trend (5x/10x)' : 'Consistent (2x/3x)';

  // Headline tone — green/red/grey emoji depending on yesterday + open positions risk
  let headline = '🌅 Daily recap';
  if (liqs > 0 || (positions.some(p => {
    const liq = num(p.liquidationPrice), mark = num(p.markPrice);
    if (!liq || !mark) return false;
    const side = (p.side || '').toLowerCase();
    const d = side === 'long' ? (mark - liq) / mark * 100 : (liq - mark) / mark * 100;
    return d > 0 && d < 5;
  }))) {
    headline = '🚨 Daily recap · attention needed';
  } else if (yesterdayPnl > 0) {
    headline = '🌅 Daily recap · clean day';
  } else if (yesterdayPnl < 0) {
    headline = '🌅 Daily recap · down day';
  }

  const lines = [
    `${headline} · ${fmtDate(dayStart)}`,
    ``,
    `Yesterday's P&L: ${pnlStr(yesterdayPnl)}`,
    `Trades: ${opens.length} opened · ${closes.length} closed (${wins}W/${losses}L)${liqs ? ' · ' + liqs + ' liq ⚠' : ''}`,
    `Fees: -$${totalFees.toFixed(2)}`,
    ``,
    `Week to date: ${pnlStr(wtdPnl)}${overBudget ? ' ⚠ over -$125 cap' : ''}${wtdLiqs ? ' · ' + wtdLiqs + ' liq' : ''}`,
    ``,
    `Open: ${positions.length}${openSummary ? '\n' + openSummary : ''}`,
    ``,
    `Regime: ${regime}`,
    `Stay bored. Make it feel like work.`,
  ];
  return lines.join('\n');
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    // Rolling 24 hours ending now, floored at TRACKING_START
    const nowSec = Math.floor(Date.now() / 1000);
    const dayEnd = nowSec;
    const dayStart = Math.max(nowSec - 24 * 3600, TRACKING_START);
    const weekStart = getWeekStart(nowSec);

    const dedupKey = `daily:${new Date(dayEnd * 1000).toISOString().slice(0, 10)}`;
    if (await shouldSkip(dedupKey, 23 * 3600)) {
      res.status(200).json({ ok: true, deduped: true, dedupKey });
      return;
    }

    const [trades, positions, settings] = await Promise.all([
      fetchTradesSince(Math.max(dayStart - 7 * 86400, TRACKING_START)), // grab a slightly wider window so WTD has its full data
      fetchPositions(),
      fetchKvHash(SETTINGS_KEY),
    ]);

    const message = composeDaily({ trades, positions, settings, dayStart, dayEnd, weekStart });
    const recipients = ['alvin', 'ken'];
    const results = {};
    for (const r of recipients) results[r] = await sendWA(r, message);
    if (Object.values(results).some(r => r.ok)) await markSent(dedupKey);

    res.status(200).json({ ok: true, dedupKey, dayStart, dayEnd, weekStart, results, messagePreview: message.slice(0, 240) });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'daily error' });
  }
}
