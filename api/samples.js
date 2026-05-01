// Equity-curve sample persistence — captures realised+unrealised P&L snapshots
// over time so the chart can show historical unrealised peaks/troughs that
// happen between closes. Each successful refresh on the dashboard POSTs one
// sample; the chart GETs the recent series.
//
// GET  /api/samples?limit=2000  → { samples: [{at, realised, unrealised, total, wallet}, ...] } chronological
// POST /api/samples             → { realised, unrealised, total, wallet, at? }

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SAMPLES_KEY = 'alvin:samples';
const SAMPLES_LIMIT = 4999; // keep ~5000 most recent

async function kvCmd(args) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`KV ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.result;
}
async function kvPipeline(commands) {
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`KV ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.map(x => x.result);
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 5000);
      const arr = await kvCmd(['LRANGE', SAMPLES_KEY, '0', String(limit - 1)]);
      const samples = (arr || []).map(safeParse).filter(Boolean);
      // LPUSH stores newest-first; reverse so the chart can read chronologically
      samples.reverse();
      res.status(200).json({ samples });
      return;
    }
    if (req.method === 'POST') {
      const { realised, unrealised, total, wallet, at } = req.body || {};
      if (typeof total !== 'number') {
        res.status(400).json({ error: 'total (number) required' });
        return;
      }
      const entry = {
        at: typeof at === 'number' ? at : Date.now(),
        realised: typeof realised === 'number' ? realised : 0,
        unrealised: typeof unrealised === 'number' ? unrealised : 0,
        total,
        wallet: typeof wallet === 'number' ? wallet : 0,
      };
      await kvPipeline([
        ['LPUSH', SAMPLES_KEY, JSON.stringify(entry)],
        ['LTRIM', SAMPLES_KEY, '0', String(SAMPLES_LIMIT)],
      ]);
      res.status(200).json({ ok: true, at: entry.at });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
