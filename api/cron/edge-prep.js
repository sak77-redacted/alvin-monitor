// Weekly edge-prep job — fires Sundays 11:55 UTC (Sunday 19:55 HKT) from
// .github/workflows/edge-prep-cron.yml, ~5 min before the edge-mining agent
// wakes up at 12:00 UTC. Pulls the last 7 days of trading activity from the
// existing KV stores + Jupiter Perps and bakes one JSON blob the agent
// reads via /api/edge-prep.
//
// Auth: accepts either ?secret=<CRON_SECRET> (matches edge-prep-cron.yml's
// curl shape) or Authorization: Bearer <CRON_SECRET> (matches the other
// cron jobs). Either is fine; both compare against the same env var.

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
const safeParse = s => { try { return JSON.parse(s); } catch { return null; } };

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
async function kvHash(key) {
  const arr = await kvCmd(['HGETALL', key]);
  const out = {};
  if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) {
    const v = safeParse(arr[i + 1]);
    if (v) out[arr[i]] = v;
  }
  return out;
}
async function kvList(key, limit) {
  const arr = await kvCmd(['LRANGE', key, '0', String(limit - 1)]);
  return (arr || []).map(safeParse).filter(Boolean);
}

async function fetchTradesSince(afterSec) {
  try {
    const r = await fetch(`https://perps-api.jup.ag/v1/trades?walletAddress=${W}&createdAtAfter=${afterSec}&start=0&end=2000`);
    return r.ok ? ((await r.json())?.dataList || []) : [];
  } catch { return []; }
}

// ISO 8601 week date: returns { year, week } where week is 1..53.
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday in current ISO week decides the year
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}
function isoWeekKey(d) {
  const { year, week } = isoWeek(d);
  return `${year}-${String(week).padStart(2, '0')}`;
}

function hourOfDayBuckets(trades) {
  // HKT = UTC+8, no DST
  const buckets = {};
  for (let h = 0; h < 24; h++) buckets[h] = { n: 0, pnl: 0 };
  for (const t of trades) {
    if (t.action !== 'Decrease') continue;
    const hourHKT = new Date((Number(t.createdTime) + 8 * 3600) * 1000).getUTCHours();
    buckets[hourHKT].n += 1;
    buckets[hourHKT].pnl += num(t.pnl);
  }
  return buckets;
}

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const querySecret = (req.query && req.query.secret) || '';
  const authed = expected && (auth === `Bearer ${expected}` || querySecret === expected);
  if (!authed) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = Math.max(nowSec - 7 * 86400, TRACKING_START);
    const fromIso = new Date(fromSec * 1000).toISOString();
    const toIso = new Date(nowSec * 1000).toISOString();
    const week = isoWeekKey(new Date(nowSec * 1000));

    const [tradesAll, journal, approvals, audit, samplesRaw, settings, regimeHistKv] = await Promise.all([
      fetchTradesSince(fromSec),
      kvHash(JOURNAL_KEY),
      kvHash(APPROVALS_KEY),
      kvList(AUDIT_KEY, 200),
      kvList(SAMPLES_KEY, 5000),
      kvHash(SETTINGS_KEY),
      kvList(REGIME_HISTORY_KEY, 200),
    ]);

    const trades = tradesAll.filter(t => Number(t.createdTime) >= fromSec);
    const samples = samplesRaw.filter(s => s && typeof s.at === 'number' && s.at >= fromSec * 1000);
    const auditWindow = audit.filter(a => a && typeof a.at === 'number' && a.at >= fromSec * 1000);

    // Journal entries are keyed by trade sig; keep just the ones whose trade
    // is in window, plus the entry timestamp for ordering.
    const journalWindow = [];
    const sigsInWindow = new Set(trades.map(t => t.txHash));
    for (const sig of Object.keys(journal)) {
      const e = journal[sig];
      if (!e) continue;
      if (sigsInWindow.has(sig) || (typeof e.at === 'number' && e.at >= fromSec * 1000)) {
        journalWindow.push({ sig, ...e });
      }
    }

    // "Violations" derived signal — pre-trade rule fires are the audit entries
    // recording approvals/unapprovals (Alvin/Ken acknowledging a flagged event).
    // Each audit entry already encodes { action, key, by, at }; keep them as-is.
    const violations = auditWindow.filter(a => a.action === 'approve' || a.action === 'unapprove');

    // Regime history snapshot. If the project hasn't populated alvin:regime_history
    // yet, fall back to a single-point record of the current regime.
    const currentRegime = settings.regime || 'consistent';
    const regimeHistory = regimeHistKv.length
      ? regimeHistKv
      : [{ at: Date.now(), regime: currentRegime, source: 'snapshot' }];

    const blob = {
      meta: {
        week,
        from_iso: fromIso,
        to_iso: toIso,
        generated_at: new Date().toISOString(),
        wallet: W,
        tracking_start_iso: new Date(TRACKING_START * 1000).toISOString(),
        current_regime: currentRegime,
      },
      trades,
      journal: journalWindow,
      samples,
      violations,
      approvals_state: approvals,
      hourly_pnl: hourOfDayBuckets(trades),
      regime_history: regimeHistory,
    };

    const payload = JSON.stringify(blob);
    const sixtyDaysSec = 60 * 86400;
    await kvCmd(['SET', `edge_prep:${week}`, payload, 'EX', String(sixtyDaysSec)]);
    await kvCmd(['SET', 'edge_prep:current', payload]);

    res.status(200).json({
      ok: true,
      week,
      from_iso: fromIso,
      to_iso: toIso,
      counts: {
        trades: trades.length,
        journal: journalWindow.length,
        samples: samples.length,
        violations: violations.length,
        regime_history: regimeHistory.length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'edge-prep error' });
  }
}
