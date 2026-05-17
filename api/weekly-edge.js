// Public-read endpoint for the dashboard's Weekly Edge panel. Returns the
// markdown report the edge-mining agent published via /api/edge-write.
//
// GET /api/weekly-edge?week=latest       → most recent published report
// GET /api/weekly-edge?week=YYYY-WW      → a specific historical report
//
// Response: { week, markdown, summary, generated_at }
// No auth — aggregated, no PII.

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
  let week = (req.query?.week || 'latest').toString().trim();
  if (week !== 'latest' && !/^\d{4}-\d{2}$/.test(week)) {
    res.status(400).json({ error: "week must be 'latest' or 'YYYY-WW'" });
    return;
  }
  try {
    if (week === 'latest') {
      const pointer = await kvCmd(['GET', 'weekly_edge:latest']);
      if (!pointer) { res.status(404).json({ error: 'no reports yet' }); return; }
      week = pointer;
    }
    const raw = await kvCmd(['GET', `weekly_edge:${week}`]);
    if (!raw) { res.status(404).json({ error: 'not found', week }); return; }
    const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(entry);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'weekly-edge read error' });
  }
}
