// HMAC-signed write endpoint for the weekly edge report. The GitHub Actions
// publish workflow (.github/workflows/weekly-edge-publish.yml) signs the
// JSON body with EDGE_HMAC_KEY and posts here. We verify the signature,
// stash the markdown in KV, and ping WhatsApp.
//
// POST /api/edge-write
//   headers: X-Signature: sha256=<hex of HMAC-SHA256(EDGE_HMAC_KEY, raw-body)>
//   body:    { week: "YYYY-WW", markdown: "...", summary: "..." }
//
// On success: writes weekly_edge:<week>, updates weekly_edge:latest,
// triggers a WhatsApp ping via /api/notify. Returns 200.

import crypto from 'crypto';

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const WEEK_RE = /^\d{4}-(0[1-9]|[1-4]\d|5[0-3])$/;

// Vercel's default body parser would consume the stream before we can HMAC
// the raw bytes. Disable it; we read the body ourselves.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function kvCmd(args) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`KV ${r.status}: ${await r.text()}`);
  return (await r.json()).result;
}

function timingSafeEqualHex(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  if (aHex.length !== bHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'));
  } catch { return false; }
}

async function pingWhatsapp(host, week, summary) {
  // Internally fan out via /api/notify so we inherit the deploy's CallMeBot
  // env vars + WAF/shell-escaping. notify.js handles 'both' recipients.
  if (!host) return { skipped: true, reason: 'no host header' };
  const url = `https://${host}/api/notify`;
  const text = `📊 Weekly edge ${week}: ${summary || '(no summary)'} → https://${host}/#weekly`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'both',
        message: text,
        dedupKey: `weekly_edge:${week}`,
        dedupTtlSec: 12 * 3600,
      }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e?.message };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const key = process.env.EDGE_HMAC_KEY;
  if (!key) {
    res.status(500).json({ error: 'EDGE_HMAC_KEY not configured' });
    return;
  }
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected' });
    return;
  }

  let raw;
  try { raw = await readRawBody(req); } catch { res.status(400).json({ error: 'unreadable body' }); return; }
  if (!raw || raw.length === 0) { res.status(400).json({ error: 'empty body' }); return; }

  const sigHeader = req.headers['x-signature'] || '';
  const m = /^sha256=([a-f0-9]+)$/i.exec(String(sigHeader));
  if (!m) { res.status(401).json({ error: 'missing or malformed X-Signature' }); return; }
  const expected = crypto.createHmac('sha256', key).update(raw).digest('hex');
  if (!timingSafeEqualHex(m[1].toLowerCase(), expected)) {
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'invalid json' }); return; }
  const week = body && body.week;
  const markdown = body && body.markdown;
  const summary = (body && body.summary) || '';
  if (typeof week !== 'string' || !WEEK_RE.test(week)) {
    res.status(400).json({ error: 'week must be YYYY-WW' });
    return;
  }
  if (typeof markdown !== 'string' || markdown.length === 0) {
    res.status(400).json({ error: 'markdown required' });
    return;
  }
  if (markdown.length > 200_000) {
    res.status(400).json({ error: 'markdown too large' });
    return;
  }

  const entry = { week, markdown, summary, generated_at: new Date().toISOString() };
  try {
    await kvCmd(['SET', `weekly_edge:${week}`, JSON.stringify(entry)]);
    await kvCmd(['SET', 'weekly_edge:latest', week]);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv write failed' });
    return;
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const notify = await pingWhatsapp(String(host).split(',')[0].trim(), week, summary);
  res.status(200).json({ ok: true, week, notify });
}
