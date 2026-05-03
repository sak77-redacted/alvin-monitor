// WhatsApp push proxy via CallMeBot. The dashboard calls this when a real-time
// trigger fires (2x/3x take-profit, liquidation proximity, just-liquidated, etc.).
// KV-backed dedup so a single condition only sends once per TTL window even if
// the frontend hits the endpoint repeatedly.
//
// POST /api/notify { to, message, dedupKey?, dedupTtlSec? }
//   to:           'alvin' | 'ken' | 'both'
//   message:      string (kept under ~600 chars; CallMeBot URL-encodes it)
//   dedupKey:     optional; if set, skip if same key fired within ttl
//   dedupTtlSec:  optional; window size for dedup (default 3600 = 1h)

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const NOTIF_KEY = 'alvin:notifications';

async function kvCmd(args) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.result;
  } catch { return null; }
}

async function shouldSkip(dedupKey, ttlSec) {
  if (!dedupKey || !ttlSec) return false;
  const v = await kvCmd(['HGET', NOTIF_KEY, dedupKey]);
  if (!v) return false;
  const at = parseInt(v, 10);
  if (isNaN(at)) return false;
  return (Date.now() - at) < (ttlSec * 1000);
}
async function markSent(dedupKey) {
  if (!dedupKey) return;
  await kvCmd(['HSET', NOTIF_KEY, dedupKey, String(Date.now())]);
}

// CallMeBot's backend appears to pipe message text through a shell, so $N
// patterns (where N is a digit) get expanded as bash positional args — `$0`
// becomes /system/bin/sh, `$300` becomes "00", etc. Insert a zero-width
// space between `$` and any digit; renders identically in WhatsApp but
// isn't a valid shell var.
function shellSafe(s) { return String(s).replace(/\$(\d)/g, '$​$1'); }
// CallMeBot's Apache mod_security blocks `\n` followed by an HTTP method word.
function wafSafe(s) { return String(s).replace(/(\n)(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE|Get|Post|Put|Delete|Head|Options|Patch|Connect|Trace)\b/g, '$1​$2'); }

async function sendWhatsapp(to, message) {
  const phoneVar = to === 'alvin' ? 'WHATSAPP_ALVIN_PHONE' : 'WHATSAPP_KEN_PHONE';
  const keyVar = to === 'alvin' ? 'WHATSAPP_ALVIN_KEY' : 'WHATSAPP_KEN_KEY';
  const phone = process.env[phoneVar];
  const key = process.env[keyVar];
  if (!phone || !key) return { ok: false, reason: `${to} not configured (${phoneVar} / ${keyVar} missing)` };
  // CallMeBot doesn't tolerate trailing newlines well; trim, cap, and shell-escape
  const text = wafSafe(shellSafe(String(message).slice(0, 800).trim()));
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url);
    const body = await r.text();
    const ok = r.ok && /(sent|queued|success)/i.test(body);
    return { ok, status: r.status, body: body.slice(0, 240) };
  } catch (e) {
    return { ok: false, reason: e?.message || 'fetch error' };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const { to, message, dedupKey, dedupTtlSec } = req.body || {};
  if (!to || !message) {
    res.status(400).json({ error: 'to + message required' });
    return;
  }
  const recipients = to === 'both' ? ['alvin', 'ken'] : [to];
  if (!recipients.every(r => r === 'alvin' || r === 'ken')) {
    res.status(400).json({ error: "to must be 'alvin' | 'ken' | 'both'" });
    return;
  }

  if (await shouldSkip(dedupKey, dedupTtlSec || 3600)) {
    res.status(200).json({ ok: true, deduped: true, dedupKey });
    return;
  }

  const results = {};
  for (const r of recipients) {
    results[r] = await sendWhatsapp(r, message);
  }
  // Mark sent if at least one recipient delivered
  if (Object.values(results).some(r => r.ok)) await markSent(dedupKey);
  res.status(200).json({ ok: true, results });
}
