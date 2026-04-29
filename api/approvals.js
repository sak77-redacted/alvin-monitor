// Shared approval state + audit log, backed by Vercel KV (Upstash Redis).
// GET  /api/approvals                                    → { approvals, audit }
// POST /api/approvals  { action, key, by }               → { ok, at }
//   action: 'approve' | 'unapprove'
//   key:    violation key (type|sig|time)
//   by:     'alvin' | 'ken'

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const APPROVALS_KEY = 'alvin:approvals';
const AUDIT_KEY = 'alvin:audit';
const AUDIT_LIMIT = 999; // keep most recent ~1000 audit entries

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

// Normalize an approval entry to { [by]: { at } } shape, tolerating the older
// single-approver { by, at } records from before two-party approval shipped.
function normalizeEntry(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') raw = safeParse(raw) || {};
  if (raw && typeof raw === 'object' && raw.by && raw.at) return { [raw.by]: { at: raw.at } };
  return raw && typeof raw === 'object' ? raw : {};
}

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected to this project' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const [approvalsArr, auditArr] = await kvPipeline([
        ['HGETALL', APPROVALS_KEY],
        ['LRANGE', AUDIT_KEY, '0', '199'],
      ]);
      const approvals = {};
      if (Array.isArray(approvalsArr)) {
        for (let i = 0; i < approvalsArr.length; i += 2) {
          const v = safeParse(approvalsArr[i + 1]);
          if (v) approvals[approvalsArr[i]] = v;
        }
      }
      const audit = (auditArr || []).map(safeParse).filter(Boolean);
      res.status(200).json({ approvals, audit });
      return;
    }

    if (req.method === 'POST') {
      const { action, key, by } = req.body || {};
      if (!action || !key || !by) {
        res.status(400).json({ error: 'action, key, by required' });
        return;
      }
      if (action !== 'approve' && action !== 'unapprove') {
        res.status(400).json({ error: 'unknown action' });
        return;
      }
      const at = Date.now();
      const auditEntry = JSON.stringify({ action, key, by, at });

      // Read-modify-write so multiple approvers stack instead of overwriting.
      const existing = await kvCmd(['HGET', APPROVALS_KEY, key]);
      const entry = normalizeEntry(existing);
      if (action === 'approve') entry[by] = { at };
      else delete entry[by];

      const writeCmds = Object.keys(entry).length === 0
        ? [['HDEL', APPROVALS_KEY, key]]
        : [['HSET', APPROVALS_KEY, key, JSON.stringify(entry)]];
      await kvPipeline([
        ...writeCmds,
        ['LPUSH', AUDIT_KEY, auditEntry],
        ['LTRIM', AUDIT_KEY, '0', String(AUDIT_LIMIT)],
      ]);
      res.status(200).json({ ok: true, at, approvers: Object.keys(entry) });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv error' });
  }
}
