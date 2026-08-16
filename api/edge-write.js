// HMAC-signed weekly-edge writer. Invoked by GH Action publish workflow after
// the Sunday-edge-mining agent commits its markdown report to main.
//
// POST /api/edge-write
//   Header: X-Signature: sha256=<hex>  (HMAC-SHA256 over raw body, key=EDGE_HMAC_KEY)
//   Body:   { week: "YYYY-WW", markdown: "...", summary: "..." }
//
// On valid signature:
//   • Writes weekly_edge:<week> (60d TTL)
//   • Updates weekly_edge:latest pointer
//   • Pushes CallMeBot WhatsApp notification to both operators
//
// Uses timing-safe compare and requires the env-configured HMAC key.

import { createHmac, timingSafeEqual } from 'crypto';

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const EDGE_HMAC_KEY = process.env.EDGE_HMAC_KEY;

const WEEK_RE = /^\d{4}-\d{2}$/;

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

// Vercel Node handlers can receive body as parsed object OR as a Buffer/string.
// For HMAC we need the exact bytes the sender signed — read the raw stream.
async function readRawBody(req) {
  // If the platform already parsed a Buffer, use it directly.
  if (req.body && Buffer.isBuffer(req.body)) return req.body;
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySig(rawBody, header) {
  if (!EDGE_HMAC_KEY || !header) return false;
  const m = /^sha256=([a-f0-9]{64})$/i.exec(String(header).trim());
  if (!m) return false;
  const expected = createHmac('sha256', EDGE_HMAC_KEY).update(rawBody).digest();
  const provided = Buffer.from(m[1], 'hex');
  if (provided.length !== expected.length) return false;
  try { return timingSafeEqual(provided, expected); } catch { return false; }
}

// CallMeBot notify helpers — mirrored from api/notify.js so we don't force
// an internal HTTP hop through a serverless function boundary.
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

  let raw;
  try { raw = await readRawBody(req); }
  catch (e) { res.status(400).json({ error: 'body read error' }); return; }

  const sig = req.headers['x-signature'] || req.headers['X-Signature'];
  if (!verifySig(raw, sig)) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { res.status(400).json({ error: 'malformed JSON body' }); return; }

  const { week, markdown, summary } = body || {};
  if (!week || !WEEK_RE.test(week) || typeof markdown !== 'string' || !markdown.trim()) {
    res.status(400).json({ error: 'week (YYYY-WW), markdown, summary required' });
    return;
  }

  try {
    const record = {
      week,
      markdown,
      summary: typeof summary === 'string' ? summary : '',
      generated_at: new Date().toISOString(),
    };
    const serialized = JSON.stringify(record);
    await kvCmd(['SET', `weekly_edge:${week}`, serialized, 'EX', String(60 * 86400)]);
    await kvCmd(['SET', 'weekly_edge:latest', week]);

    // Fire-and-forget WhatsApp — non-fatal if it fails, KV write already succeeded.
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'alvin-monitor.vercel.app';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const link = `${proto}://${host}/#weekly`;
    const msg = `📊 Weekly edge ${week}: ${record.summary || '(new report)'} → ${link}`;
    const results = {};
    for (const r of ['alvin', 'ken']) results[r] = await sendWA(r, msg);

    res.status(200).json({ ok: true, week, notified: results });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'edge-write error' });
  }
}

// Vercel Node runtime: disable body parsing so we can HMAC the raw bytes.
export const config = { api: { bodyParser: false } };
