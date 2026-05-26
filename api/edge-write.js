// HMAC-signed write endpoint for the weekly edge-mining agent. The GitHub
// Action that publishes reports/weekly_edge_latest.md signs the JSON body
// with EDGE_HMAC_KEY (shared between Vercel env and GitHub repo secrets) and
// POSTs it here. On verified signature we store the markdown, update the
// 'latest' pointer, and fire a single WhatsApp ping to both Alvin + Ken.
//
// POST /api/edge-write
//   Headers: X-Signature: sha256=<hex>
//   Body:    { week: 'YYYY-WW', markdown: '...', summary: '...' }

import crypto from 'crypto';

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Disable Vercel's default body parser so we can read raw bytes and compute
// the HMAC over what the GH Action actually signed. The parsed JSON would
// re-serialise with different whitespace and break verification.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

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
async function kvPipeline(commands) {
  if (!KV_URL || !KV_TOKEN) return [];
  try {
    const r = await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!r.ok) return [];
    return (await r.json()).map(x => x.result);
  } catch { return []; }
}

function shellSafe(s) { return String(s).replace(/\$(\d)/g, '$​$1'); }
function wafSafe(s) { return String(s).replace(/(\n)(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE|Get|Post|Put|Delete|Head|Options|Patch|Connect|Trace)\b/g, '$1​$2'); }

async function sendWA(to, message) {
  const phoneVar = to === 'alvin' ? 'WHATSAPP_ALVIN_PHONE' : 'WHATSAPP_KEN_PHONE';
  const keyVar = to === 'alvin' ? 'WHATSAPP_ALVIN_KEY' : 'WHATSAPP_KEN_KEY';
  const phone = process.env[phoneVar], key = process.env[keyVar];
  if (!phone || !key) return { ok: false };
  const text = wafSafe(shellSafe(String(message).slice(0, 800).trim()));
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url);
    const body = await r.text();
    return { ok: r.ok && /(sent|queued|success)/i.test(body) };
  } catch { return { ok: false }; }
}

function verifySignature(rawBody, headerSig, secret) {
  if (!headerSig || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Tolerate either bare hex or "sha256=<hex>"
  const provided = headerSig.startsWith('sha256=') ? headerSig.slice(7) : headerSig;
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const secret = process.env.EDGE_HMAC_KEY;
  if (!secret) {
    res.status(500).json({ error: 'EDGE_HMAC_KEY not configured' });
    return;
  }
  let raw;
  try { raw = await readRawBody(req); }
  catch { res.status(400).json({ error: 'could not read body' }); return; }

  const sig = req.headers['x-signature'] || req.headers['X-Signature'];
  if (!verifySignature(raw, sig, secret)) {
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch { res.status(400).json({ error: 'invalid JSON' }); return; }

  const { week, markdown, summary } = parsed || {};
  if (!week || !/^\d{4}-\d{2}$/.test(week) || typeof markdown !== 'string' || !markdown.trim()) {
    res.status(400).json({ error: "week (YYYY-WW) + markdown required" });
    return;
  }
  const cleanSummary = (typeof summary === 'string' ? summary : '').trim().slice(0, 240);

  try {
    const entry = JSON.stringify({
      week,
      markdown,
      summary: cleanSummary,
      generated_at: new Date().toISOString(),
    });
    await kvPipeline([
      ['SET', `weekly_edge:${week}`, entry],
      ['SET', `weekly_edge:latest`, week],
    ]);

    // Best-effort WhatsApp ping. Don't fail the request if WA is down — the
    // KV write is the source of truth and the dashboard surfaces the report.
    const host = process.env.DEPLOY_HOST || 'https://alvin-monitor.vercel.app';
    const message = `📊 Weekly edge ${week}: ${cleanSummary || 'report ready'} → ${host}/#weekly`;
    const waResults = await Promise.all([sendWA('alvin', message), sendWA('ken', message)]);

    res.status(200).json({ ok: true, week, wa: { alvin: waResults[0].ok, ken: waResults[1].ok } });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'edge-write error' });
  }
}
