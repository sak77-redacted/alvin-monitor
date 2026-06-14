// HMAC-signed write endpoint for the weekly edge report.
//
// POST /api/edge-write
//   header  X-Signature: sha256=<hex>   ← HMAC-SHA256(EDGE_HMAC_KEY, raw body bytes)
//   body    { week:"YYYY-WW", markdown:"...", summary:"..." }
//
// On valid signature:
//   - writes markdown to KV under weekly_edge:YYYY-WW
//   - updates pointer weekly_edge:latest → YYYY-WW
//   - WhatsApp-pings Ken via inline CallMeBot (same scheme as api/cron/digest.js)
//
// We disable Vercel's body parser so the HMAC verification can run over the
// exact bytes the client signed; a re-serialised JSON.stringify(body) would
// not be byte-identical and signatures would fail intermittently.

import crypto from 'node:crypto';

export const config = { api: { bodyParser: false } };

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const NOTIF_KEY = 'alvin:notifications';

const DEPLOY_HOST = process.env.DEPLOY_HOST || 'https://alvin-monitor.vercel.app';

async function kvCmd(args) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return null;
    return (await r.json()).result;
  } catch { return null; }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Re-use the same shell/WAF dodges as api/notify.js so weird markdown text
// can't trip CallMeBot's bash expansion or mod_security pattern.
function shellSafe(s) { return String(s).replace(/\$(\d)/g, '$​$1'); }
function wafSafe(s) { return String(s).replace(/(\n)(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE|Get|Post|Put|Delete|Head|Options|Patch|Connect|Trace)\b/g, '$1​$2'); }

async function sendWhatsapp(to, message) {
  const phoneVar = to === 'alvin' ? 'WHATSAPP_ALVIN_PHONE' : 'WHATSAPP_KEN_PHONE';
  const keyVar = to === 'alvin' ? 'WHATSAPP_ALVIN_KEY' : 'WHATSAPP_KEN_KEY';
  const phone = process.env[phoneVar], key = process.env[keyVar];
  if (!phone || !key) return { ok: false, reason: `${to} not configured` };
  const text = wafSafe(shellSafe(String(message).slice(0, 800).trim()));
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url);
    const body = await r.text();
    return { ok: r.ok && /(sent|queued|success)/i.test(body), body: body.slice(0, 200) };
  } catch (e) { return { ok: false, reason: e?.message }; }
}

async function markSent(dedupKey) {
  if (dedupKey) await kvCmd(['HSET', NOTIF_KEY, dedupKey, String(Date.now())]);
}

function timingSafeEqHex(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  if (aHex.length !== bHex.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex')); }
  catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.EDGE_HMAC_KEY) {
    res.status(500).json({ error: 'EDGE_HMAC_KEY not configured' });
    return;
  }
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'Vercel KV not connected' });
    return;
  }

  let raw;
  try { raw = await readRawBody(req); }
  catch (e) { res.status(400).json({ error: 'could not read body' }); return; }

  const header = String(req.headers['x-signature'] || '');
  const m = header.match(/^sha256=([0-9a-f]+)$/i);
  if (!m) { res.status(401).json({ error: 'missing or malformed X-Signature' }); return; }
  const expected = crypto.createHmac('sha256', process.env.EDGE_HMAC_KEY).update(raw).digest('hex');
  if (!timingSafeEqHex(m[1].toLowerCase(), expected)) {
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { res.status(400).json({ error: 'body not JSON' }); return; }

  const { week, markdown, summary } = body || {};
  if (!week || !/^\d{4}-\d{2}$/.test(String(week))) {
    res.status(400).json({ error: 'week must be YYYY-WW' }); return;
  }
  if (typeof markdown !== 'string' || !markdown.trim()) {
    res.status(400).json({ error: 'markdown required' }); return;
  }
  const generated_at = new Date().toISOString();
  const record = JSON.stringify({ week, markdown, summary: summary || '', generated_at });

  try {
    await Promise.all([
      kvCmd(['SET', `weekly_edge:${week}`, record]),
      kvCmd(['SET', 'weekly_edge:latest', week]),
    ]);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'kv write failed' });
    return;
  }

  const short = (summary || markdown.split('\n').find(l => l.trim() && !l.startsWith('#')) || '').slice(0, 240);
  const dedupKey = `weekly_edge:${week}`;
  const whatsappResult = await sendWhatsapp(
    'ken',
    `📊 Weekly edge ${week}: ${short} → ${DEPLOY_HOST}/#weekly`
  );
  if (whatsappResult.ok) await markSent(dedupKey);

  res.status(200).json({ ok: true, week, generated_at, whatsapp: whatsappResult.ok });
}
