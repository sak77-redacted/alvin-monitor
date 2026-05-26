// Sunday 11:55 UTC prep job for the weekly edge-mining agent. Pulls the last
// 7 days of trades, journal, samples, violations + audit, regime history, and
// hour-of-day P&L buckets, then writes the aggregated blob to KV under both
// edge_prep:YYYY-WW (ISO week) and edge_prep:current. The agent runs at 12:00
// UTC, reads /api/edge-prep, produces a markdown report, and signs it back
// through /api/edge-write.
//
// Auth: Authorization: Bearer <CRON_SECRET>. Same secret as the other cron
// endpoints. Triggered by .github/workflows/edge-prep-cron.yml on
// '55 11 * * 0' (Sundays 11:55 UTC = 19:55 HKT).

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
async function kvPipeline(commands) {
  if (!KV_URL || !KV_TOKEN) return [];
  try {
    const r = await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!r.ok) return [];
    return (await r.json()).map(x => x.result);
  } catch { return []; }
}
async function fetchKvHash(key) {
  const arr = await kvCmd(['HGETALL', key]);
  const out = {};
  if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) {
    try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch {}
  }
  return out;
}

async function fetchTradesSince(afterSec) {
  try {
    const r = await fetch(`https://perps-api.jup.ag/v1/trades?walletAddress=${W}&createdAtAfter=${afterSec}&start=0&end=2000`);
    return r.ok ? ((await r.json())?.dataList || []) : [];
  } catch { return []; }
}

// ISO-8601 week number, e.g. 2026-W20 → '2026-20'. Week 1 contains the year's
// first Thursday; weeks run Mon–Sun. Matches GitHub Actions cron timing
// (Sundays 11:55 UTC) so the week label reflects the Mon–Sun window that just
// closed.
function isoWeekTag(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-${String(weekNum).padStart(2, '0')}`;
}

function bucketHourOfDayPnL(trades) {
  // HKT (UTC+8, no DST). Bucket each Decrease event's realised P&L by HKT hour.
  const buckets = {};
  for (let h = 0; h < 24; h++) buckets[h] = { count: 0, sumPnl: 0, wins: 0, losses: 0 };
  for (const t of trades) {
    if (t.action !== 'Decrease') continue;
    const pnl = num(t.pnl);
    const hkt = new Date((t.createdTime + 8 * 3600) * 1000);
    const h = hkt.getUTCHours();
    const b = buckets[h];
    b.count++;
    b.sumPnl += pnl;
    if (pnl > 0) b.wins++; else if (pnl < 0) b.losses++;
  }
  return buckets;
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const toSec = nowSec;
    const fromSec = Math.max(nowSec - 7 * 86400, TRACKING_START);
    const weekTag = isoWeekTag(new Date(nowSec * 1000));

    const [trades, journalMap, approvalsArr, auditArr, samplesArr, settings, regimeHistArr] = await Promise.all([
      fetchTradesSince(fromSec),
      fetchKvHash(JOURNAL_KEY),
      kvCmd(['HGETALL', APPROVALS_KEY]),
      kvCmd(['LRANGE', AUDIT_KEY, '0', '999']),
      kvCmd(['LRANGE', SAMPLES_KEY, '0', '4999']),
      fetchKvHash(SETTINGS_KEY),
      kvCmd(['LRANGE', REGIME_HISTORY_KEY, '0', '199']),
    ]);

    // Journal entries scoped to this week (by close txHash → entry.at)
    const sigsThisWeek = new Set(trades.filter(t => t.action === 'Decrease').map(t => t.txHash));
    const journal = [];
    for (const sig in journalMap) {
      const j = journalMap[sig];
      if (!j) continue;
      if (sigsThisWeek.has(sig) || (j.at && j.at >= fromSec * 1000 && j.at <= toSec * 1000)) {
        journal.push({ sig, ...j });
      }
    }

    // Approvals → normalise to a flat list of audit-style entries this week
    const approvals = {};
    if (Array.isArray(approvalsArr)) {
      for (let i = 0; i < approvalsArr.length; i += 2) {
        const v = safeParse(approvalsArr[i + 1]);
        if (v) approvals[approvalsArr[i]] = v;
      }
    }
    const audit = (auditArr || []).map(safeParse).filter(Boolean)
      .filter(a => a.at && a.at >= fromSec * 1000 && a.at <= toSec * 1000);

    // Samples — bound to the 7-day window
    const samples = (samplesArr || []).map(safeParse).filter(Boolean)
      .filter(s => s.at && s.at >= fromSec * 1000 && s.at <= toSec * 1000)
      .sort((a, b) => a.at - b.at);

    // Regime history — list of { at, regime, by } if the dashboard records it.
    // Fall back to a synthetic single-entry list if the key is empty so the
    // agent still gets a regime tag to attribute trades against.
    let regime_history = (regimeHistArr || []).map(safeParse).filter(Boolean);
    if (!regime_history.length) {
      regime_history = [{ at: fromSec * 1000, regime: settings.regime || 'consistent', by: 'default' }];
    }

    // Pre-trade rule fires near each trade open — for each Increase event,
    // look for a violation/approval audit entry within 5 min before it.
    const violations = audit.filter(a => a.action === 'approve' || a.action === 'unapprove');

    // Hour-of-day P&L buckets (HKT)
    const hourly_pnl = bucketHourOfDayPnL(trades);

    const blob = {
      meta: {
        week: weekTag,
        from_iso: new Date(fromSec * 1000).toISOString(),
        to_iso: new Date(toSec * 1000).toISOString(),
        generated_at: new Date().toISOString(),
        wallet: W,
      },
      trades,
      journal,
      samples,
      violations,
      approvals,
      hourly_pnl,
      regime_history,
      settings,
    };

    const payload = JSON.stringify(blob);
    await kvPipeline([
      ['SET', `edge_prep:${weekTag}`, payload, 'EX', String(60 * 86400)],
      ['SET', `edge_prep:current`, payload],
    ]);

    res.status(200).json({
      ok: true,
      week: weekTag,
      from: blob.meta.from_iso,
      to: blob.meta.to_iso,
      counts: {
        trades: trades.length,
        journal: journal.length,
        samples: samples.length,
        violations: violations.length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'edge-prep error' });
  }
}
