// Server-side proxy that hides HELIUS_API_KEY from the client bundle.
// POST  /api/helius                      → JSON-RPC passthrough to mainnet.helius-rpc.com
// GET   /api/helius?address=<W>&limit=&before=  → enhanced-transactions passthrough

export default async function handler(req, res) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'HELIUS_API_KEY not set in Vercel env' });
    return;
  }

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await r.json();
      res.status(r.status).json(data);
      return;
    }

    if (req.method === 'GET') {
      const { address, limit = '100', before } = req.query;
      if (!address) {
        res.status(400).json({ error: 'address query param required' });
        return;
      }
      let url = `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(address)}/transactions?api-key=${key}&limit=${encodeURIComponent(limit)}`;
      if (before) url += `&before=${encodeURIComponent(before)}`;
      const r = await fetch(url);
      const data = await r.json();
      res.status(r.status).json(data);
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(502).json({ error: e?.message || 'proxy error' });
  }
}
