// Public read endpoint for the published weekly edge report. Powers the
// "Weekly Edge Report" panel on the dashboard's Weekly tab.
//
// GET /api/weekly-edge?week=latest         → { week, markdown, summary, generated_at }
// GET /api/weekly-edge?week=current        → alias for latest
// GET /api/weekly-edge?week=YYYY-WW        → archived week

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
  const want = String(req.query.week || 'latest').trim();
  if (want !== 'latest' && want !== 'current' && !/^\d{4}-\d{2}$/.test(want)) {
    res.status(400).json({ error: "week must be 'latest', 'current', or YYYY-WW" });
    return;
  }
  try {
    let week = want;
    if (week === 'latest' || week === 'current') {
      const pointer = await kvCmd(['GET', 'weekly_edge:latest']);
      if (!pointer) { res.status(404).json({ error: 'no published reports yet' }); return; }
      week = String(pointer);
    }
    const raw = await kvCmd(['GET', `weekly_edge:${week}`]);
    if (!raw) { res.status(404).json({ error: 'not found', week }); return; }
    let body;
    try { body = JSON.parse(raw); } catch { body = { week, markdown: String(raw), generated_at: null }; }
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(body);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
