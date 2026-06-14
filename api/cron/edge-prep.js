// Weekly edge-mining prep job. Runs Sunday 11:55 UTC (just before 12:00 UTC =
// 20:00 HKT, when the Claude Code routine fires) and snapshots the last 7d of
// realised outcomes + journal/approval state into KV. The routine then reads
// /api/edge-prep, analyses the buckets, and ships reports/weekly_edge_*.md.
//
// Auth: Authorization: Bearer <CRON_SECRET> (matches existing api/cron/*).
//
// Writes:
//   edge_prep:YYYY-WW   (60d TTL)
//   edge_prep:current   (14d TTL, overwritten weekly)

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const W = "6gYeaEULEH6f6Pu1SpcgnENUonKegjGa8f6GWwreyqQt";
const TRACKING_START = Math.floor(new Date('2026-04-28T00:00:00Z').getTime() / 1000);
const APPROVALS_KEY = 'alvin:approvals';
const AUDIT_KEY = 'alvin:audit';
const JOURNAL_KEY = 'alvin:journal';
const SAMPLES_KEY = 'alvin:samples';
const SETTINGS_KEY = 'alvin:settings';
const REGIME_HISTORY_KEY = 'alvin:regime_history';

const num = v => typeof v === 'string' ? parseFloat(v) || 0 : (v || 0);

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
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
async function fetchKvHash(key) {
  const arr = await kvCmd(['HGETALL', key]);
  const out = {};
  if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) {
    const v = safeParse(arr[i + 1]);
    if (v != null) out[arr[i]] = v;
  }
  return out;
}
async function fetchKvList(key, limit = 1000) {
  const arr = await kvCmd(['LRANGE', key, '0', String(limit - 1)]);
  return (arr || []).map(safeParse).filter(Boolean);
}

async function fetchTradesSince(afterSec) {
  try {
    const r = await fetch(`https://perps-api.jup.ag/v1/trades?walletAddress=${W}&createdAtAfter=${afterSec}&start=0&end=2000`);
    return r.ok ? ((await r.json())?.dataList || []) : [];
  } catch { return []; }
}

// ISO-8601 week label (YYYY-WW). Sunday-of-Week-N renders the same key as the
// preceding Mon-Sat per ISO rules.
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNum).padStart(2, '0')}`;
}

// Hour-of-day P&L bucket in HKT — only Decrease events (realised) count.
function hourlyPnlBuckets(trades) {
  const buckets = {};
  for (let h = 0; h < 24; h++) buckets[String(h).padStart(2, '0')] = { count: 0, sum: 0 };
  for (const t of trades) {
    if (t.action !== 'Decrease') continue;
    const pnl = num(t.pnl);
    // HKT is UTC+8, no DST.
    const hourHkt = (new Date(t.createdTime * 1000).getUTCHours() + 8) % 24;
    const key = String(hourHkt).padStart(2, '0');
    buckets[key].count += 1;
    buckets[key].sum += pnl;
  }
  return buckets;
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
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
    const week = isoWeekKey(new Date(nowSec * 1000));

    const [trades, journal, approvals, audit, samples, settings, regimeHistoryRaw] = await Promise.all([
      fetchTradesSince(fromSec),
      fetchKvHash(JOURNAL_KEY),
      fetchKvHash(APPROVALS_KEY),
      fetchKvList(AUDIT_KEY, 500),
      fetchKvList(SAMPLES_KEY, 2000),
      fetchKvHash(SETTINGS_KEY),
      kvCmd(['LRANGE', REGIME_HISTORY_KEY, '0', '199']),
    ]);

    const samplesInWindow = samples.filter(s => s.at >= fromSec * 1000);
    const regimeHistory = (Array.isArray(regimeHistoryRaw) ? regimeHistoryRaw : [])
      .map(safeParse).filter(Boolean);

    // Build violations array from audit log — entries inside the window with
    // action 'approve' on a known violation key tell us a rule fired and was
    // dispositioned. (The dashboard recomputes raw violations client-side
    // from trades + rules; we capture the audit trail here.)
    const fromMs = fromSec * 1000;
    const violations = audit
      .filter(a => a && a.at >= fromMs)
      .map(a => ({ key: a.key, action: a.action, by: a.by, at: a.at }));

    const journalInWindow = {};
    for (const sig in journal) {
      const j = journal[sig];
      if (j && j.at >= fromMs) journalInWindow[sig] = j;
    }

    const blob = {
      meta: {
        week,
        from_iso: new Date(fromSec * 1000).toISOString(),
        to_iso: new Date(nowSec * 1000).toISOString(),
        generated_at: new Date().toISOString(),
        wallet: W,
        tracking_start_iso: new Date(TRACKING_START * 1000).toISOString(),
      },
      trades,
      journal: journalInWindow,
      samples: samplesInWindow,
      approvals,
      violations,
      hourly_pnl: hourlyPnlBuckets(trades),
      regime_history: regimeHistory,
      settings,
    };

    const payload = JSON.stringify(blob);
    await Promise.all([
      // 60 days for the archived week, 14 days for :current as a stale guard
      kvCmd(['SET', `edge_prep:${week}`, payload, 'EX', String(60 * 86400)]),
      kvCmd(['SET', `edge_prep:current`, payload, 'EX', String(14 * 86400)]),
    ]);

    res.status(200).json({
      ok: true,
      week,
      from: blob.meta.from_iso,
      to: blob.meta.to_iso,
      counts: {
        trades: trades.length,
        journal: Object.keys(journalInWindow).length,
        samples: samplesInWindow.length,
        violations: violations.length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'edge-prep error' });
  }
}
