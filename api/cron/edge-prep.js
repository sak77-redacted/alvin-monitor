// Sunday 11:55 UTC prep job — aggregates last 7d of trading activity into a
// single KV blob that the weekly edge-mining routine reads at 12:00 UTC.
//
// GET /api/cron/edge-prep
//   Auth: ?secret=<CRON_SECRET> query param, OR Authorization: Bearer <CRON_SECRET>.
//   Query supported so the GH workflow can be a one-liner curl.
//
// Writes:
//   edge_prep:YYYY-WW   (60d TTL — ISO-week key)
//   edge_prep:current   (no TTL — pointer replaced weekly)

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const W = "6gYeaEULEH6f6Pu1SpcgnENUonKegjGa8f6GWwreyqQt";
const TRACKING_START = Math.floor(new Date('2026-04-28T00:00:00Z').getTime() / 1000);

const JOURNAL_KEY = 'alvin:journal';
const APPROVALS_KEY = 'alvin:approvals';
const AUDIT_KEY = 'alvin:audit';
const SAMPLES_KEY = 'alvin:samples';
const SETTINGS_KEY = 'alvin:settings';
const REGIME_HISTORY_KEY = 'alvin:regime_history';

const TOKEN_SYMBOLS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'wETH',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'wBTC',
};
const num = v => typeof v === 'string' ? parseFloat(v) || 0 : (v || 0);
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

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
    const v = safeParse(arr[i + 1]);
    if (v != null) out[arr[i]] = v;
  }
  return out;
}
async function fetchKvList(key, limit = 999) {
  const arr = await kvCmd(['LRANGE', key, '0', String(limit)]);
  return (arr || []).map(safeParse).filter(Boolean);
}

async function fetchTradesSince(afterSec) {
  try {
    const r = await fetch(`https://perps-api.jup.ag/v1/trades?walletAddress=${W}&createdAtAfter=${afterSec}&start=0&end=2000`);
    return r.ok ? ((await r.json())?.dataList || []) : [];
  } catch { return []; }
}

// ISO-8601 week number. Alvin's Monday-start weekly cadence lines up with
// ISO weeks, which start on Monday.
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

// Bucket closed trades by hour-of-day in HKT (UTC+8). Only Decrease events
// carry realised P&L, so open events are excluded here.
function bucketByHour(trades) {
  const buckets = {};
  for (let h = 0; h < 24; h++) buckets[h] = { count: 0, pnl: 0, wins: 0, losses: 0 };
  for (const t of trades) {
    if (t.action !== 'Decrease') continue;
    const hkt = new Date((Number(t.createdTime) + 8 * 3600) * 1000);
    const h = hkt.getUTCHours();
    const pnl = num(t.pnl);
    buckets[h].count += 1;
    buckets[h].pnl += pnl;
    if (pnl > 0) buckets[h].wins += 1;
    else if (pnl < 0) buckets[h].losses += 1;
  }
  return buckets;
}

// Approvals audit log gives us a compact violation stream. The dashboard's
// full checkCompliance runs client-side; the aggregate we can reconstruct is
// the set of keys operators had to acknowledge, which is what the analysis
// agent needs to correlate against trade timestamps.
function extractViolations(approvals, audit) {
  const seen = new Map();
  for (const [key, entry] of Object.entries(approvals || {})) {
    const parts = key.split('|');
    const type = parts[0] || 'UNKNOWN';
    const sig = parts[1] || '';
    const at = parts[2] ? parseInt(parts[2], 10) : null;
    const approvers = Object.keys(entry || {});
    seen.set(key, { key, type, sig, at, approvers, approved: approvers.length > 0 });
  }
  // Audit log records approve/unapprove events — include historical violation
  // keys even if they've since been unapproved.
  for (const entry of audit || []) {
    if (!entry?.key || seen.has(entry.key)) continue;
    const parts = entry.key.split('|');
    seen.set(entry.key, {
      key: entry.key, type: parts[0] || 'UNKNOWN', sig: parts[1] || '',
      at: parts[2] ? parseInt(parts[2], 10) : null,
      approvers: [], approved: false,
    });
  }
  return Array.from(seen.values());
}

async function recordRegimeSnapshot(nowSec, settings) {
  const regime = settings?.regime || 'consistent';
  // LPUSH newest-first with a bounded list. Read-back reverses to chronological.
  const entry = JSON.stringify({ at: nowSec * 1000, regime });
  await kvCmd(['LPUSH', REGIME_HISTORY_KEY, entry]);
  await kvCmd(['LTRIM', REGIME_HISTORY_KEY, '0', '199']);
}

export default async function handler(req, res) {
  const querySecret = req.query?.secret;
  const auth = req.headers.authorization || '';
  const bearerOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const queryOk = process.env.CRON_SECRET && querySecret === process.env.CRON_SECRET;
  if (!bearerOk && !queryOk) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected' });
    return;
  }

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = Math.max(nowSec - 7 * 86400, TRACKING_START);
    const week = isoWeek(new Date(nowSec * 1000));

    const [trades, journal, approvals, audit, samples, settings, regimeHistory] = await Promise.all([
      fetchTradesSince(fromSec),
      fetchKvHash(JOURNAL_KEY),
      fetchKvHash(APPROVALS_KEY),
      fetchKvList(AUDIT_KEY, 999),
      fetchKvList(SAMPLES_KEY, 4999),
      fetchKvHash(SETTINGS_KEY),
      fetchKvList(REGIME_HISTORY_KEY, 199),
    ]);

    await recordRegimeSnapshot(nowSec, settings);

    // Filter samples to window, chronological
    const fromMs = fromSec * 1000;
    const windowSamples = samples.filter(s => s?.at >= fromMs).reverse();

    // Journal entries for closes in-window
    const inWindow = trades.filter(t => Number(t.createdTime) >= fromSec);
    const closeSigs = new Set(inWindow.filter(t => t.action === 'Decrease').map(t => t.txHash));
    const journalEntries = [];
    for (const [sig, entry] of Object.entries(journal || {})) {
      if (closeSigs.has(sig)) journalEntries.push({ sig, ...entry });
    }

    // Attach a compact symbol tag to each trade so the analyst doesn't have to
    // re-derive mint→symbol every time.
    const enrichedTrades = inWindow.map(t => ({
      ...t,
      symbol: t.positionName || TOKEN_SYMBOLS[t.mint] || t.mint || '?',
      pnl_num: num(t.pnl),
      collateral_num: num(t.collateralUsd ?? t.usdcIn ?? 0),
      fee_num: num(t.fee),
    }));

    const violations = extractViolations(approvals, audit);
    const hourlyPnl = bucketByHour(enrichedTrades);

    const blob = {
      meta: {
        week,
        from_iso: new Date(fromSec * 1000).toISOString(),
        to_iso: new Date(nowSec * 1000).toISOString(),
        generated_at: new Date(nowSec * 1000).toISOString(),
        wallet: W,
      },
      trades: enrichedTrades,
      journal: journalEntries,
      samples: windowSamples,
      violations,
      hourly_pnl: hourlyPnl,
      regime_history: regimeHistory
        .slice()
        .reverse()
        .filter(e => e?.at >= fromMs - 30 * 86400 * 1000),
      settings_snapshot: settings,
    };

    const serialized = JSON.stringify(blob);
    // 60-day TTL on the week-keyed record; leave the "current" pointer TTL-less.
    await kvCmd(['SET', `edge_prep:${week}`, serialized, 'EX', String(60 * 86400)]);
    await kvCmd(['SET', 'edge_prep:current', serialized]);

    res.status(200).json({
      ok: true,
      week,
      from: blob.meta.from_iso,
      to: blob.meta.to_iso,
      counts: {
        trades: enrichedTrades.length,
        journal: journalEntries.length,
        violations: violations.length,
        samples: windowSamples.length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'edge-prep error' });
  }
}
