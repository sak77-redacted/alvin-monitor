// HMAC-signed weekly-edge writer. Invoked by GH Action publish workflow after
// the Sunday-edge-mining agent commits its markdown report to main.
//
// POST /api/edge-write
//   Header: X-Signature: sha256=<hex>
//   Body:   { week: "YYYY-WW", markdown: "...", summary: "..." }
//
// Signature is HMAC-SHA256 over a canonical string, not the raw JSON body:
//   canonical = `${week}\n${sha256_hex(markdown)}\n${summary || ''}`
// so we don't depend on request-body-parsing quirks (Vercel auto-parses JSON
// but the raw bytes aren't reliably exposed once that happens). Signing over
// parsed fields keeps signature verification deterministic regardless of how
// the platform buffers the body.
//
// On valid signature:
//   • Writes weekly_edge:<week> (60d TTL)
//   • Updates weekly_edge:latest pointer
//   • Pushes CallMeBot WhatsApp notification to both operators

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const EDGE_HMAC_KEY = process.env.EDGE_HMAC_KEY;

const WEEK_RE = /^\d{4}-\d{2}$/;
const enc = new TextEncoder();

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

function hex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

async function sha256Hex(s) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(s));
  return hex(d);
}

async function hmacSha256Hex(key, message) {
  const k = await globalThis.crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', k, enc.encode(message));
  return hex(sig);
}

// Constant-time hex string compare so signature verification isn't
// vulnerable to a timing side-channel. Both inputs are lowercase hex.
function timingSafeStrEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// CallMeBot notify helpers — mirrored from api/notify.js to avoid an internal
// HTTP hop between two serverless functions.
function shellSafe(s) { return String(s).replace(/\$(\d)/g, '$​$1'); }
function wafSafe(s) { return String(s).replace(/(\n)(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE|Get|Post|Put|Delete|Head|Options|Patch|Connect|Trace)\b/g, '$1​$2'); }
async function sendWA(to, message) {
  const phoneVar = to === 'alvin' ? 'WHATSAPP_ALVIN_PHONE' : 'WHATSAPP_KEN_PHONE';
  const keyVar = to === 'alvin' ? 'WHATSAPP_ALVIN_KEY' : 'WHATSAPP_KEN_KEY';
  const phone = process.env[phoneVar], key = process.env[keyVar];
  if (!phone || !key) return { ok: false, reason: `${to} not configured` };
  const text = wafSafe(shellSafe(String(message).slice(0, 800).trim()));
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url);
    const body = await r.text();
    return { ok: r.ok && /(sent|queued|success)/i.test(body) };
  } catch (e) { return { ok: false, reason: e?.message }; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!EDGE_HMAC_KEY) {
    res.status(500).json({ error: 'EDGE_HMAC_KEY not configured' });
    return;
  }
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected' });
    return;
  }

  const body = req.body || {};
  const week = typeof body.week === 'string' ? body.week : '';
  const markdown = typeof body.markdown === 'string' ? body.markdown : '';
  const summary = typeof body.summary === 'string' ? body.summary : '';

  if (!WEEK_RE.test(week) || !markdown.trim()) {
    res.status(400).json({ error: 'week (YYYY-WW) and non-empty markdown required' });
    return;
  }

  const sigHeader = req.headers['x-signature'] || req.headers['X-Signature'] || '';
  const m = /^sha256=([a-f0-9]{64})$/i.exec(String(sigHeader).trim());
  if (!m) {
    res.status(401).json({ error: 'missing or malformed X-Signature' });
    return;
  }

  const canonical = `${week}\n${await sha256Hex(markdown)}\n${summary}`;
  const expected = await hmacSha256Hex(EDGE_HMAC_KEY, canonical);
  if (!timingSafeStrEq(m[1].toLowerCase(), expected.toLowerCase())) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  try {
    const record = { week, markdown, summary, generated_at: new Date().toISOString() };
    const serialized = JSON.stringify(record);
    await kvCmd(['SET', `weekly_edge:${week}`, serialized, 'EX', String(60 * 86400)]);
    await kvCmd(['SET', 'weekly_edge:latest', week]);

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'alvin-monitor.vercel.app';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const link = `${proto}://${host}/#weekly`;
    const msg = `📊 Weekly edge ${week}: ${summary || '(new report)'} → ${link}`;
    const results = {};
    for (const r of ['alvin', 'ken']) results[r] = await sendWA(r, msg);

    res.status(200).json({ ok: true, week, notified: results });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'edge-write error' });
  }
}
