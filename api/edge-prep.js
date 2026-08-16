// Public read of the weekly edge-prep aggregate blob.
//
// GET /api/edge-prep?week=current      → latest blob (Sunday-refreshed)
// GET /api/edge-prep?week=YYYY-WW      → ISO-week keyed historical blob
//
// No auth — aggregated public trading data; the wallet address is already
// public on-chain and no PII is stored. Consumed by the Sunday agent + any
// analyst tooling.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

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

const WEEK_RE = /^\d{4}-\d{2}$/;

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected' });
    return;
  }
  const weekParam = String(req.query?.week || 'current').trim();
  const key = weekParam === 'current'
    ? 'edge_prep:current'
    : WEEK_RE.test(weekParam) ? `edge_prep:${weekParam}` : null;
  if (!key) {
    res.status(400).json({ error: 'week must be "current" or "YYYY-WW"' });
    return;
  }
  try {
    const raw = await kvCmd(['GET', key]);
    if (!raw) {
      res.status(404).json({ error: 'not found', key });
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    // KV stored a JSON string. Pass through verbatim to preserve field order.
    res.status(200).send(raw);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
