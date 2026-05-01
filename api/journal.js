// Per-close trade journal — captures Alvin's debrief on each closed/liquidated
// trade so the failure modes from the chat ('didn't set stop in time',
// 'hopium', 'distraction', 'didn't take profit') become tracked data instead
// of one-off messages.
//
// GET  /api/journal                                → { journal: { [sig]: {...} } }
// POST /api/journal  { sig, by, ... fields }       → upsert one entry
// DELETE /api/journal  { sig, by }                 → remove one entry
//
// Each entry shape: { rules: 'yes'|'partial'|'no', exit, distractions,
//                     thesis, reflection, by, at }

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const JOURNAL_KEY = 'alvin:journal';

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
      const arr = await kvCmd(['HGETALL', JOURNAL_KEY]);
      const journal = {};
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i += 2) {
          const v = safeParse(arr[i + 1]);
          if (v) journal[arr[i]] = v;
        }
      }
      res.status(200).json({ journal });
      return;
    }
    if (req.method === 'POST') {
      const { sig, by, rules, exit, distractions, thesis, reflection } = req.body || {};
      if (!sig || !by) {
        res.status(400).json({ error: 'sig + by required' });
        return;
      }
      const entry = {
        rules: rules || '',
        exit: exit || '',
        distractions: distractions || '',
        thesis: thesis || '',
        reflection: reflection || '',
        by, at: Date.now(),
      };
      await kvCmd(['HSET', JOURNAL_KEY, sig, JSON.stringify(entry)]);
      res.status(200).json({ ok: true, entry });
      return;
    }
    if (req.method === 'DELETE') {
      const { sig, by } = req.body || {};
      if (!sig || !by) { res.status(400).json({ error: 'sig + by required' }); return; }
      await kvCmd(['HDEL', JOURNAL_KEY, sig]);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
