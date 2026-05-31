// Public read endpoint for the rendered weekly edge report. The dashboard's
// Weekly tab fetches this on activation to show the latest report. The
// pointer key weekly_edge:latest is set by /api/edge-write each Sunday.
//
// GET /api/weekly-edge?week=latest  → most recent report
// GET /api/weekly-edge?week=YYYY-WW → that ISO-week's report

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const WEEK_RE = /^\d{4}-(0[1-9]|[1-4]\d|5[0-3])$/;

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
  const weekRaw = (req.query && req.query.week) || 'latest';
  let week = String(weekRaw).trim();
  if (week === 'latest') {
    const pointer = await kvGet('weekly_edge:latest');
    if (!pointer || !WEEK_RE.test(pointer)) {
      res.status(404).json({ error: 'no weekly edge report published yet' });
      return;
    }
    week = pointer;
  } else if (!WEEK_RE.test(week)) {
    res.status(400).json({ error: 'week must be "latest" or YYYY-WW' });
    return;
  }
  const raw = await kvGet(`weekly_edge:${week}`);
  if (!raw) {
    res.status(404).json({ error: 'report not found', week });
    return;
  }
  let entry;
  try { entry = JSON.parse(raw); } catch { entry = null; }
  if (!entry || typeof entry.markdown !== 'string') {
    res.status(500).json({ error: 'malformed entry in KV', week });
    return;
  }
  res.status(200).json({
    week: entry.week || week,
    markdown: entry.markdown,
    summary: entry.summary || '',
    generated_at: entry.generated_at || null,
  });
}
