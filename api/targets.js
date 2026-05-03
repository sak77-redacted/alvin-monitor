// Per-position exit target lockbox — when Alvin opens a position, he commits
// to a planned exit price. The dashboard surfaces it on the position card,
// and post-close we can compare actual exit to planned target ('left on the
// table' analytics). Not a stop-loss in the traditional sense; max loss is
// already capped by the collateral, so this is the discipline of declaring
// the exit *before* greed/hopium sets in.
//
// GET    /api/targets                                       → { targets: { [pubkey]: {...} } }
// POST   /api/targets  { positionPubkey, exitPrice, thesis, by, side?, market? } → upsert
// DELETE /api/targets  { positionPubkey, by }               → remove

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TARGETS_KEY = 'alvin:targets';

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
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const arr = await kvCmd(['HGETALL', TARGETS_KEY]);
      const targets = {};
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i += 2) {
          const v = safeParse(arr[i + 1]);
          if (v) targets[arr[i]] = v;
        }
      }
      res.status(200).json({ targets });
      return;
    }
    if (req.method === 'POST') {
      const { positionPubkey, exitPrice, thesis, by, side, market, chart } = req.body || {};
      if (!positionPubkey || !by) {
        res.status(400).json({ error: 'positionPubkey + by required' });
        return;
      }
      const hasPrice = typeof exitPrice === 'number' && exitPrice > 0;
      const hasChart = typeof chart === 'string' && chart.startsWith('data:image/') && chart.length < 900_000;
      if (!hasPrice && !hasChart) {
        res.status(400).json({ error: 'either a numeric exitPrice or a chart data-URL required' });
        return;
      }
      const entry = {
        positionPubkey,
        exitPrice: hasPrice ? exitPrice : null,
        thesis: thesis || '',
        chart: hasChart ? chart : null,
        side: side || '',
        market: market || '',
        by, at: Date.now(),
      };
      await kvCmd(['HSET', TARGETS_KEY, positionPubkey, JSON.stringify(entry)]);
      res.status(200).json({ ok: true, entry: { ...entry, chart: hasChart ? '[stored]' : null } });
      return;
    }
    if (req.method === 'DELETE') {
      const { positionPubkey, by } = req.body || {};
      if (!positionPubkey || !by) { res.status(400).json({ error: 'positionPubkey + by required' }); return; }
      await kvCmd(['HDEL', TARGETS_KEY, positionPubkey]);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
