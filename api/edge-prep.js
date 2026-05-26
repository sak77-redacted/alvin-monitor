// Public-read endpoint that serves the aggregated prep blob the Sunday 11:55
// cron job (api/cron/edge-prep.js) writes to KV. The weekly edge-mining agent
// reads from here at 12:00 UTC to compute its report.
//
// GET /api/edge-prep?week=current        → latest prep blob
// GET /api/edge-prep?week=YYYY-WW        → historical week (retained 60d)
//
// No auth — aggregated metrics, the wallet is already public, no PII.

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
  const week = (req.query?.week || 'current').toString().trim();
  if (!/^(current|\d{4}-\d{2})$/.test(week)) {
    res.status(400).json({ error: "week must be 'current' or 'YYYY-WW'" });
    return;
  }
  try {
    const raw = await kvCmd(['GET', `edge_prep:${week}`]);
    if (!raw) {
      res.status(404).json({ error: 'not found', week });
      return;
    }
    const blob = typeof raw === 'string' ? JSON.parse(raw) : raw;
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(blob);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'edge-prep read error' });
  }
}
