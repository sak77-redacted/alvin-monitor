// Server-side trigger evaluator. Called every ~5 minutes by GitHub Actions
// (free) or any external cron-style HTTP pinger. Replicates the same trigger
// conditions the dashboard frontend evaluates on each refresh, so notifications
// fire even when nobody has the dashboard open.
//
// Auth: requires Authorization: Bearer <CRON_SECRET>. Set CRON_SECRET as a
// Vercel env var AND as the matching GitHub Actions secret.
//
// Triggers:
// - Take-profit 2x / 3x of position collateral (regime-aware)
// - Exit-target hit (mark crossed Alvin's declared exit price)
// - Liquidation distance < 5% / < 2%
// - Just-happened liquidation in the last 30 minutes
//
// All notifications go through CallMeBot via the same KV-deduped path
// /api/notify uses, so the dashboard and the cron can't double-fire each other.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const W = "6gYeaEULEH6f6Pu1SpcgnENUonKegjGa8f6GWwreyqQt";
const TRACKING_START = Math.floor(new Date('2026-04-28T00:00:00Z').getTime() / 1000);

const NOTIF_KEY = 'alvin:notifications';
const TARGETS_KEY = 'alvin:targets';
const SETTINGS_KEY = 'alvin:settings';

const TOKEN_SYMBOLS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'wETH',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'wBTC',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
};
const num = v => typeof v === 'string' ? parseFloat(v) || 0 : (v || 0);
const pnlStr = v => v > 0 ? `+$${v.toFixed(2)}` : v < 0 ? `-$${Math.abs(v).toFixed(2)}` : '$0';
function getWeekKey(d) {
  const s = new Date(d); s.setUTCDate(s.getUTCDate() - s.getUTCDay() + 1);
  return s.toISOString().slice(0, 10);
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
async function fetchKvHash(key) {
  const arr = await kvCmd(['HGETALL', key]);
  const out = {};
  if (Array.isArray(arr)) {
    for (let i = 0; i < arr.length; i += 2) {
      try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch {}
    }
  }
  return out;
}
async function shouldSkip(dedupKey, ttlSec) {
  if (!dedupKey) return false;
  const v = await kvCmd(['HGET', NOTIF_KEY, dedupKey]);
  if (!v) return false;
  const at = parseInt(v, 10);
  return !isNaN(at) && (Date.now() - at) < ttlSec * 1000;
}
async function markSent(dedupKey) {
  if (!dedupKey) return;
  await kvCmd(['HSET', NOTIF_KEY, dedupKey, String(Date.now())]);
}
// CallMeBot's backend pipes message text through a shell — $N patterns get
// bash-expanded as positional args. Insert a zero-width space between $ and
// any digit; renders identically in WhatsApp but isn't a valid shell var.
function shellSafe(s) { return String(s).replace(/\$(\d)/g, '$​$1'); }
// CallMeBot's Apache mod_security blocks `\n` followed by an HTTP method word.
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
async function notify(to, message, dedupKey, dedupTtlSec) {
  if (await shouldSkip(dedupKey, dedupTtlSec)) return { deduped: true };
  const recipients = to === 'both' ? ['alvin', 'ken'] : [to];
  const results = {};
  for (const r of recipients) results[r] = await sendWA(r, message);
  if (Object.values(results).some(r => r.ok)) await markSent(dedupKey);
  return { deduped: false, results };
}

async function fetchPositions() {
  try {
    const r = await fetch(`https://perps-api.jup.ag/v1/positions?walletAddress=${W}`);
    if (!r.ok) return [];
    return (await r.json())?.dataList || [];
  } catch { return []; }
}
async function fetchRecentLiquidations() {
  try {
    const cutoff = Math.max(Math.floor(Date.now() / 1000) - 30 * 60, TRACKING_START);
    const r = await fetch(`https://perps-api.jup.ag/v1/trades?walletAddress=${W}&createdAtAfter=${cutoff}&start=0&end=100`);
    if (!r.ok) return [];
    return ((await r.json())?.dataList || []).filter(t => t.orderType === 'Liquidation');
  } catch { return []; }
}

export default async function handler(req, res) {
  // Auth — refuse unless the caller has the shared secret
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const fired = [];
  try {
    const [positions, liquidations, settings, targets] = await Promise.all([
      fetchPositions(), fetchRecentLiquidations(),
      fetchKvHash(SETTINGS_KEY), fetchKvHash(TARGETS_KEY),
    ]);

    const regime = settings.regime || 'consistent';
    const tier2 = regime === 'trend' ? 4 : 1;
    const tier3 = regime === 'trend' ? 9 : 2;
    const label2 = regime === 'trend' ? '5x' : '2x';
    const label3 = regime === 'trend' ? '10x' : '3x';

    // 1. Take-profit 2x / 3x per open position
    for (const p of positions) {
      const pnl = num(p.pnlAfterFeesUsd ?? p.pnl ?? p.pnlAfterFees);
      const collat = num(p.collateralUsd);
      if (collat <= 0) continue;
      const ratio = pnl / collat;
      const pk = p.positionPubkey || 'unknown';
      const market = p.positionName || TOKEN_SYMBOLS[p.marketMint] || '?';
      const side = (p.side || '').toUpperCase();
      const summary = `${side} ${market} · ${ratio.toFixed(2)}x · ${pnlStr(pnl)} on $${collat.toFixed(2)} collateral`;
      if (ratio >= tier3) {
        const r = await notify('both',
          `🚨 Alvin, DON'T BE AN AWHEAD, CLOSE THE TRADE! · ${label3}\n\nIt's okay. Eat first. There's more where that came.\n\n${summary}\n\nAfter close, sweep $${pnl.toFixed(0)} → multisig.`,
          `tp3:${pk}`, 3 * 3600);
        if (!r.deduped) fired.push({ kind: 'tp3', position: pk });
      } else if (ratio >= tier2) {
        const r = await notify('alvin',
          `⚠ TAKE PROFIT · hit ${label2} · greed is hopium\n\n${summary}\n\nAfter close, sweep $${pnl.toFixed(0)} → multisig.`,
          `tp2:${pk}:${getWeekKey(new Date())}`, 6 * 3600);
        if (!r.deduped) fired.push({ kind: 'tp2', position: pk });
      }
    }

    // 2. Exit-target hit
    for (const p of positions) {
      const pk = p.positionPubkey;
      if (!pk) continue;
      const tgt = targets[pk];
      if (!tgt || typeof tgt.exitPrice !== 'number' || tgt.exitPrice <= 0) continue;
      const target = tgt.exitPrice;
      const mark = num(p.markPrice ?? p.currentPrice ?? p.indexPrice);
      if (!mark) continue;
      const side = (p.side || '').toLowerCase();
      const hit = side === 'long' ? mark >= target : side === 'short' ? mark <= target : false;
      if (!hit) continue;
      const pnl = num(p.pnlAfterFeesUsd ?? p.pnl);
      const collat = num(p.collateralUsd);
      const ratio = collat > 0 ? pnl / collat : 0;
      const market = p.positionName || TOKEN_SYMBOLS[p.marketMint] || '?';
      const ratioStr = ratio > 0 ? ` · ${ratio.toFixed(2)}x of collateral` : '';
      const thesisLine = tgt.thesis ? `\n\nThesis: "${tgt.thesis}"` : '';
      const r = await notify('both',
        `🎯 EXIT TARGET HIT · ${side.toUpperCase()} ${market}\n\nMark $${mark.toFixed(2)} ${side === 'long' ? '≥' : '≤'} target $${target.toFixed(2)}\nUnrealised ${pnlStr(pnl)}${ratioStr}${thesisLine}\n\nClose per your plan.`,
        `tgt:${pk}:${target.toFixed(4)}`, 4 * 3600);
      if (!r.deduped) fired.push({ kind: 'target', position: pk });
    }

    // 3. Liquidation distance < 5% (and < 2% as a louder tier)
    for (const p of positions) {
      const pk = p.positionPubkey || 'unknown';
      const liq = num(p.liquidationPrice);
      const mark = num(p.markPrice ?? p.currentPrice);
      if (!liq || !mark) continue;
      const side = (p.side || '').toLowerCase();
      const dist = side === 'long' ? ((mark - liq) / mark) * 100 : ((liq - mark) / mark) * 100;
      if (dist <= 0 || dist >= 5) continue;
      const market = p.positionName || TOKEN_SYMBOLS[p.marketMint] || '?';
      const tier = dist < 2 ? 3 : 2;
      const headline = tier === 3 ? `🔴 LIQUIDATION IMMINENT · <2% AWAY` : `⚠ LIQUIDATION CLOSE · <5% AWAY`;
      const summary = `${side.toUpperCase()} ${market} · ${dist.toFixed(2)}% from liq · mark $${mark.toFixed(2)} · liq $${liq.toFixed(2)}`;
      const r = await notify('alvin',
        `${headline}\n\n${summary}\n\nClose, add collateral, or get liquidated.`,
        `liqClose:${pk}:t${tier}`, tier === 3 ? 600 : 1800);
      if (!r.deduped) fired.push({ kind: 'liqClose', tier, position: pk });
    }

    // 4. Just-happened liquidation in the last 30 min
    for (const t of liquidations) {
      const pnl = num(t.pnl);
      const market = t.positionName || TOKEN_SYMBOLS[t.mint] || '?';
      const side = (t.side || '').toUpperCase();
      const at = new Date(t.createdTime * 1000).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
      const r = await notify('both',
        `🔴 LIQUIDATION · ${side} ${market}\n\nLost $${Math.abs(pnl).toFixed(2)} · ${at}\n\nCooldown rules now apply.`,
        `liq:${t.txHash}`, 30 * 86400);
      if (!r.deduped) fired.push({ kind: 'liquidated', sig: t.txHash });
    }

    res.status(200).json({ ok: true, regime, fired, checked: { positions: positions.length, liquidations: liquidations.length } });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'cron error' });
  }
}
