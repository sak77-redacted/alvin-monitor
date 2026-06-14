// Public read endpoint for the weekly edge-prep blob. The Sunday 11:55 UTC
// cron (api/cron/edge-prep.js) snapshots the last 7d of trades/journal/audit
// into KV; this endpoint serves it back so the Claude Code weekly routine
// (and anyone curious) can fetch it.
//
// GET /api/edge-prep?week=current        → latest snapshot
// GET /api/edge-prep?week=YYYY-WW        → archived week (60d TTL)
//
// No auth — aggregated wallet data is public on-chain anyway; the journal
// hash already exposes Alvin's own free-text reflections through the
// dashboard. No PII in the blob.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected' });
    return;
  }
  const wk = String(req.query.week || 'current').trim();
  if (wk !== 'current' && !/^\d{4}-\d{2}$/.test(wk)) {
    res.status(400).json({ error: "week must be 'current' or YYYY-WW" });
    return;
  }
  try {
    const raw = await kvCmd(['GET', `edge_prep:${wk}`]);
    if (!raw) {
      res.status(404).json({ error: 'not found', week: wk });
      return;
    }
    let body;
    try { body = JSON.parse(raw); } catch { body = { raw }; }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(body);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
