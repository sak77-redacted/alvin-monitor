// Generic shared key/value settings store backed by Vercel KV. Used right
// now for the trading-regime toggle (consistent 2-3x vs trend chasing
// 5-10x); designed to be extensible for any future app-level setting Alvin
// and Ken need to agree on.
//
// GET  /api/settings                         → { settings: { [key]: value } }
// POST /api/settings { key, value, by }      → upsert one setting
//
// Settings recognised today:
// - regime: 'consistent' | 'trend'   (defaults to 'consistent')

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SETTINGS_KEY = 'alvin:settings';

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
      const arr = await kvCmd(['HGETALL', SETTINGS_KEY]);
      const settings = {};
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i += 2) {
          const v = safeParse(arr[i + 1]);
          if (v != null) settings[arr[i]] = v;
        }
      }
      res.status(200).json({ settings });
      return;
    }
    if (req.method === 'POST') {
      const { key, value, by } = req.body || {};
      if (!key || value == null || !by) {
        res.status(400).json({ error: 'key + value + by required' });
        return;
      }
      await kvCmd(['HSET', SETTINGS_KEY, key, JSON.stringify(value)]);
      res.status(200).json({ ok: true, key, value });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
