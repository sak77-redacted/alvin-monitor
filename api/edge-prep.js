// Public read endpoint for the weekly edge-prep blob. The Sunday 11:55 UTC
// cron writes the blob to KV; the edge-mining agent reads it from here at
// 12:00 UTC. No auth — the payload contains aggregated trading stats keyed
// to a public wallet, no PII.
//
// GET /api/edge-prep?week=current    → latest blob
// GET /api/edge-prep?week=YYYY-WW    → that ISO-week's blob

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['GET', key]),
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
  const weekRaw = (req.query && req.query.week) || 'current';
  const week = String(weekRaw).trim();
  // Accept "current" or strict YYYY-WW (year 4 digits, week 2 digits 01-53)
  if (week !== 'current' && !/^\d{4}-(0[1-9]|[1-4]\d|5[0-3])$/.test(week)) {
    res.status(400).json({ error: 'week must be "current" or YYYY-WW' });
    return;
  }
  const kvKey = week === 'current' ? 'edge_prep:current' : `edge_prep:${week}`;
  const raw = await kvGet(kvKey);
  if (!raw) {
    res.status(404).json({ error: 'prep blob not found', week });
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  // Already-stringified JSON; pass through verbatim.
  res.status(200).send(raw);
}
