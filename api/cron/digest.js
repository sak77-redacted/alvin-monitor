// Monday-morning weekly digest to Ken via WhatsApp. Pulls last 7 days of
// Jupiter Perps activity + KV state and sends a single concise message
// summarising the week so Ken doesn't have to open the dashboard to know
// whether the trial is on track.
//
// Auth: Authorization: Bearer <CRON_SECRET>. Same secret as the 5-min check.
//
// Schedule (.github/workflows/digest-cron.yml): Monday 9am AEST = Sunday
// 23:00 UTC during AEST (UTC+10). The trial runs May–Aug 2026 — entirely
// AEST, no DST switch — so a single UTC schedule is correct for the trial.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const W = "6gYeaEULEH6f6Pu1SpcgnENUonKegjGa8f6GWwreyqQt";
const TRACKING_START = Math.floor(new Date('2026-04-28T00:00:00Z').getTime() / 1000);
const BUDGET_WEEKLY = 125;
const NOTIF_KEY = 'alvin:notifications';
const APPROVALS_KEY = 'alvin:approvals';
const JOURNAL_KEY = 'alvin:journal';
const SETTINGS_KEY = 'alvin:settings';

const TOKEN_SYMBOLS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'wETH',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'wBTC',
};
const num = v => typeof v === 'string' ? parseFloat(v) || 0 : (v || 0);
const pnlStr = v => v > 0 ? `+$${v.toFixed(2)}` : v < 0 ? `-$${Math.abs(v).toFixed(2)}` : '$0';

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
  const text = String(message).slice(0, 1500).trim(); // CallMeBot tolerates ~4000 chars; cap at 1500 for readability
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

function isoDate(d) { return d.toISOString().slice(0, 10); }
function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short' });
}

function composeDigest({ trades, positions, approvals, journal, settings, weekStart, weekEnd }) {
  // Aggregate stats over the week's closes
  const closes = trades.filter(t => t.action === 'Decrease' && t.createdTime >= weekStart && t.createdTime < weekEnd);
  const wins = closes.filter(t => num(t.pnl) > 0).length;
  const losses = closes.filter(t => num(t.pnl) < 0).length;
  const liqs = closes.filter(t => t.orderType === 'Liquidation').length;
  const totalPnl = closes.reduce((s, t) => s + num(t.pnl), 0);
  const winRate = closes.length ? Math.round(wins / closes.length * 100) : 0;
  const totalFees = closes.reduce((s, t) => s + num(t.fee), 0);

  // Top exit reasons from journal entries that pertain to this week's closes
  const sigsThisWeek = new Set(closes.map(c => c.txHash));
  const exitCounts = {};
  for (const sig in journal) {
    if (!sigsThisWeek.has(sig)) continue;
    const e = journal[sig]?.exit;
    if (e) exitCounts[e] = (exitCounts[e] || 0) + 1;
  }
  const exitLabels = { hit_tp:'hit TP', hit_sl:'hit SL', liquidation:'liq', thesis_changed:'thesis changed', froze:'froze', hopium:'hopium', manual_close:'manual', other:'other' };
  const topExits = Object.entries(exitCounts).sort((a,b) => b[1]-a[1]).slice(0, 3);

  // Open unapproved violations — count from approvals state vs known violation sigs in trades
  // Cheap approximation: count approval entries; the dashboard's full violation feed isn't
  // recomputed here. For Ken's Monday glance this is good enough.
  const approvalCount = Object.keys(approvals).length;

  // Open positions snapshot
  const openSummary = positions.map(p => {
    const pnl = num(p.pnlAfterFeesUsd ?? p.pnl);
    const collat = num(p.collateralUsd);
    const ratio = collat > 0 ? (pnl / collat).toFixed(2) + 'x' : '?';
    const market = p.positionName || TOKEN_SYMBOLS[p.marketMint] || '?';
    const side = (p.side || '').toUpperCase();
    return `· ${side} ${market} · ${pnlStr(pnl)} (${ratio})`;
  }).join('\n');

  const regime = settings.regime === 'trend' ? 'Trend (5x/10x)' : 'Consistent (2x/3x)';

  const lines = [
    `📊 Weekly digest · week of ${fmtDate(weekStart)} – ${fmtDate(weekEnd - 1)}`,
    ``,
    `Realised P&L: ${pnlStr(totalPnl)}${totalPnl <= -BUDGET_WEEKLY ? ' ⚠ over loss budget' : ''}`,
    `Closes: ${closes.length} · ${wins}W / ${losses}L · win rate ${winRate}%`,
    `Liquidations: ${liqs}${liqs >= 3 ? ' ⚠' : ''}`,
    `Fees paid: -$${totalFees.toFixed(2)}`,
    ``,
    `Open positions: ${positions.length}${openSummary ? '\n' + openSummary : ''}`,
    ``,
    `Top exit patterns this week:`,
    topExits.length
      ? topExits.map(([k, n]) => `· ${exitLabels[k] || k}: ${n}`).join('\n')
      : '· no journals filled',
    ``,
    `Active approvals on file: ${approvalCount}`,
    `Regime: ${regime}`,
    ``,
    'Open the dashboard for the Compliance + Trades detail.',
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
    // Last completed week: Monday 00:00 AEST → next Monday 00:00 AEST. We're firing
    // at Monday 09:00 AEST, so the week ending = today's Monday 00:00 AEST.
    const now = new Date();
    const sydMidnight = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
    sydMidnight.setHours(0, 0, 0, 0);
    // Walk back to most recent Monday in Sydney time
    while (sydMidnight.getDay() !== 1) sydMidnight.setDate(sydMidnight.getDate() - 1);
    const tzOffsetHours = (now.getTime() - new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' })).getTime()) / 3600000;
    const weekEnd = Math.floor(sydMidnight.getTime() / 1000) + Math.round(tzOffsetHours * 3600);
    const weekStart = weekEnd - 7 * 86400;

    // Dedup per (week-start) so accidental double-trigger of the workflow doesn't double-send
    const dedupKey = `digest:${new Date(weekStart * 1000).toISOString().slice(0, 10)}`;
    if (await shouldSkip(dedupKey, 6 * 86400)) {
      res.status(200).json({ ok: true, deduped: true, dedupKey });
      return;
    }

    const [trades, positions, approvals, journal, settings] = await Promise.all([
      fetchTradesSince(Math.max(weekStart, TRACKING_START)),
      fetchPositions(),
      fetchKvHash(APPROVALS_KEY),
      fetchKvHash(JOURNAL_KEY),
      fetchKvHash(SETTINGS_KEY),
    ]);

    const message = composeDigest({ trades, positions, approvals, journal, settings, weekStart, weekEnd });
    const result = await sendWA('ken', message);
    if (result.ok) await markSent(dedupKey);

    res.status(200).json({ ok: true, sent: result.ok, dedupKey, weekStart, weekEnd, messagePreview: message.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'digest error' });
  }
}
