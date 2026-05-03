// Vision-LLM chart reader. Takes a data-URL image (typically a
// TradingView screenshot Alvin pasted into the exit-target modal),
// asks Claude Haiku to identify the drawn target line, and returns
// {target_price, current_price, side, confidence, reasoning}.
//
// POST /api/read-chart  { dataUrl }
//
// Requires ANTHROPIC_API_KEY in Vercel env. Falls back to a clear
// error if the key isn't configured.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 500;

const PROMPT = `You are looking at a TradingView chart screenshot. The trader has likely drawn one or more horizontal lines representing their exit/target price (often distinctly colored, possibly labeled "TP", "Target", "Exit", or similar).

Identify:
1. target_price — the numeric price level of the most prominent USER-DRAWN horizontal line. Do NOT use the current-market-price line (a thin dashed line at the right edge usually showing the live price). If a price label is visible on the line, use that exact value; otherwise estimate from the y-axis ticks.
2. current_price — the current/last price visible on the chart, usually labeled at the right edge.
3. side — "long" if target is ABOVE current price, "short" if target is BELOW. null if unclear.
4. confidence — your 0-1 confidence in target_price specifically. Be conservative; if the chart has multiple drawn lines, lower confidence.
5. reasoning — one short sentence explaining what you saw.

Return ONLY a single JSON object, no markdown fences, no commentary:
{"target_price": <number or null>, "current_price": <number or null>, "side": "long"|"short"|null, "confidence": <0-1>, "reasoning": "<one sentence>"}

If you cannot identify any user-drawn target line, return target_price: null with a reasoning that explains why.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!ANTHROPIC_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured in Vercel env' });
    return;
  }
  const { dataUrl } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') {
    res.status(400).json({ error: 'dataUrl required' });
    return;
  }
  const m = /^data:(image\/(?:jpeg|jpg|png|gif|webp));base64,(.+)$/i.exec(dataUrl);
  if (!m) {
    res.status(400).json({ error: 'invalid data URL — expected data:image/...;base64,...' });
    return;
  }
  const mediaType = m[1].replace('jpg', 'jpeg').toLowerCase();
  const base64 = m[2];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });
    const body = await r.json();
    if (!r.ok) {
      res.status(502).json({ error: 'Anthropic API error', status: r.status, detail: body?.error?.message || body });
      return;
    }
    const text = body?.content?.[0]?.text || '';
    let parsed = null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch {}
    }
    if (!parsed) {
      res.status(502).json({ error: 'could not parse model response', raw: text.slice(0, 500) });
      return;
    }
    // Coerce types defensively
    const out = {
      target_price: typeof parsed.target_price === 'number' ? parsed.target_price : (parsed.target_price ? parseFloat(parsed.target_price) || null : null),
      current_price: typeof parsed.current_price === 'number' ? parsed.current_price : (parsed.current_price ? parseFloat(parsed.current_price) || null : null),
      side: parsed.side === 'long' || parsed.side === 'short' ? parsed.side : null,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
      reasoning: String(parsed.reasoning || '').slice(0, 240),
      model: MODEL,
      tokens: body?.usage || null,
    };
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e?.message || 'fetch failed' });
  }
}
