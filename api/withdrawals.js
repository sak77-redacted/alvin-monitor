// Withdrawal-to-destination reconciliation. When Ken releases funds from the
// multisig with a stated purpose ("buy NEAR"), the system records the claim
// plus the Tangem NEAR baseline at that moment. After the deadline the
// dashboard checks: did the Tangem balance grow by ≈ the claimed amount?
// If not, the claim was false — banner + WhatsApp to both.
//
// GET    /api/withdrawals                        → { withdrawals: { [id]: entry } }
// POST   /api/withdrawals                        → create
//   { amountUsd, claimedAsset, destination, baselineBalance, baselinePrice,
//     hours?, note?, by }
// PATCH  /api/withdrawals  { id, status, by, evidence? }   → resolve (verify | violate | cancel)
// DELETE /api/withdrawals  { id, by }            → remove (input error / accidental log)

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'alvin:withdrawals';
const AUDIT_KEY = 'alvin:audit';

const DEFAULT_HOURS = 48;
const VALID_STATUS = new Set(['pending', 'verified', 'violated', 'cancelled']);

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
const safeParse = s => { try { return JSON.parse(s); } catch { return null; } };

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const arr = await kvCmd(['HGETALL', KEY]);
      const withdrawals = {};
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i += 2) {
          const v = safeParse(arr[i + 1]);
          if (v) withdrawals[arr[i]] = v;
        }
      }
      res.status(200).json({ withdrawals });
      return;
    }

    if (req.method === 'POST') {
      const { amountUsd, claimedAsset, destination, baselineBalance, baselinePrice, hours, note, by } = req.body || {};
      if (!by) { res.status(400).json({ error: 'by required' }); return; }
      const amt = parseFloat(amountUsd);
      if (!(amt > 0)) { res.status(400).json({ error: 'amountUsd > 0 required' }); return; }
      const asset = (claimedAsset || 'NEAR').toUpperCase();
      const dest = destination || 'tangem-near';
      const baseBal = parseFloat(baselineBalance);
      const basePrice = parseFloat(baselinePrice);
      if (!(baseBal >= 0) || !(basePrice > 0)) {
        res.status(400).json({ error: 'baselineBalance ≥ 0 and baselinePrice > 0 required (capture from current S.near)' });
        return;
      }
      const now = Date.now();
      const windowH = hours && hours > 0 ? Math.min(hours, 168) : DEFAULT_HOURS;
      const id = 'w_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const entry = {
        id, amountUsd: amt, claimedAsset: asset, destination: dest,
        baselineBalance: baseBal, baselinePrice: basePrice,
        approvedAt: now, deadlineAt: now + windowH * 3600 * 1000,
        status: 'pending', resolvedAt: null, evidence: null,
        note: (note || '').slice(0, 200), by,
      };
      await kvPipeline([
        ['HSET', KEY, id, JSON.stringify(entry)],
        ['LPUSH', AUDIT_KEY, JSON.stringify({ action: 'withdrawal:create', key: id, by, at: now, amountUsd: amt, asset, dest })],
        ['LTRIM', AUDIT_KEY, '0', '999'],
      ]);
      res.status(200).json({ ok: true, entry });
      return;
    }

    if (req.method === 'PATCH') {
      const { id, status, by, evidence } = req.body || {};
      if (!id || !by || !status) { res.status(400).json({ error: 'id, status, by required' }); return; }
      if (!VALID_STATUS.has(status)) { res.status(400).json({ error: 'unknown status' }); return; }
      const raw = await kvCmd(['HGET', KEY, id]);
      const entry = safeParse(raw);
      if (!entry) { res.status(404).json({ error: 'not found' }); return; }
      entry.status = status;
      entry.resolvedAt = Date.now();
      entry.resolvedBy = by;
      if (evidence) entry.evidence = String(evidence).slice(0, 400);
      await kvPipeline([
        ['HSET', KEY, id, JSON.stringify(entry)],
        ['LPUSH', AUDIT_KEY, JSON.stringify({ action: 'withdrawal:' + status, key: id, by, at: entry.resolvedAt })],
        ['LTRIM', AUDIT_KEY, '0', '999'],
      ]);
      res.status(200).json({ ok: true, entry });
      return;
    }

    if (req.method === 'DELETE') {
      const { id, by } = req.body || {};
      if (!id || !by) { res.status(400).json({ error: 'id + by required' }); return; }
      await kvPipeline([
        ['HDEL', KEY, id],
        ['LPUSH', AUDIT_KEY, JSON.stringify({ action: 'withdrawal:delete', key: id, by, at: Date.now() })],
        ['LTRIM', AUDIT_KEY, '0', '999'],
      ]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
