// Public read of the latest weekly edge markdown report. Consumed by the
// dashboard Weekly tab's "Weekly Edge Report" panel.
//
// GET /api/weekly-edge?week=latest       → { week, markdown, summary, generated_at }
// GET /api/weekly-edge?week=YYYY-WW      → same shape for a specific week
// GET /api/weekly-edge?week=current      → alias for latest
//
// Returns 404 if no report has been published yet.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const WEEK_RE = /^\d{4}-\d{2}$/;

async function kvCmd(args) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`KV ${r.status}`);
  return (await r.json()).result;
}

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected' });
    return;
  }
  const weekParam = String(req.query?.week || 'latest').trim();
  try {
    let week = weekParam;
    if (week === 'latest' || week === 'current') {
      const pointer = await kvCmd(['GET', 'weekly_edge:latest']);
      if (!pointer) {
        res.status(404).json({ error: 'no reports published yet' });
        return;
      }
      week = String(pointer);
    }
    if (!WEEK_RE.test(week)) {
      res.status(400).json({ error: 'week must be "latest", "current", or "YYYY-WW"' });
      return;
    }
    const raw = await kvCmd(['GET', `weekly_edge:${week}`]);
    if (!raw) {
      res.status(404).json({ error: 'not found', week });
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(raw);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
