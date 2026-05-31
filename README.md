# Alvin Trading Monitor

Live Solana wallet monitor for the Alvin & Ken trading control framework.

## Deploy to Vercel

### Option A: Vercel CLI (fastest)

```bash
# 1. Unzip this project
unzip alvin-monitor.zip
cd alvin-monitor

# 2. Deploy
npx vercel

# 3. Follow the prompts — accept all defaults
# Done. You'll get a URL like https://alvin-monitor-xxxxx.vercel.app
```

### Option B: Vercel Dashboard (no CLI needed)

1. Go to [vercel.com/new](https://vercel.com/new)
2. Click **"Import Git Repository"** → or just drag the `alvin-monitor` folder
3. Framework: **Other**
4. Output directory: **public**
5. Click **Deploy**

### Option C: Push to GitHub first

```bash
cd alvin-monitor
git init
git add .
git commit -m "Alvin trading monitor"
gh repo create alvin-monitor --public --push
```

Then import the repo at [vercel.com/new](https://vercel.com/new).

## What it monitors

- **Wallet**: `6gYeaEULEH6f6Pu1SpcgnENUonKegjGa8f6GWwreyqQt`
- **Multisig**: `Grtrn5eT3pPADCMxx2NMiM4bzHT44rZy6yp7AwhHGXSZ`
- SOL and USDC balances
- Recent transactions (last 5 parsed in detail)
- Source verification — flags any deposits NOT from the multisig
- Budget utilization gauge ($125/week)

## RPC Configuration

The dashboard tries these Solana RPC endpoints in order:
1. Helius (if API key provided)
2. Ankr (`rpc.ankr.com/solana`)
3. PublicNode (`solana-rpc.publicnode.com`)
4. Solana mainnet (`api.mainnet-beta.solana.com`)

When deployed on Vercel with a proper HTTPS origin, the public RPCs should work fine without needing a Helius key.

## Weekly Edge Mining (Sunday 20:00 HKT)

A weekly agent inspects the last 7d of trades + journals + violations and
publishes a short report to the Weekly tab — flagging hour-of-day buckets,
regime tilts, position-size bands, and one concrete config change to try.

### Required env vars

New for this routine:

- `EDGE_HMAC_KEY` — shared secret used to authenticate the agent's report
  write. Set the **same value** in both:
  - Vercel project env: `EDGE_HMAC_KEY=<value>`
  - GitHub repo secret: `EDGE_HMAC_KEY=<value>`
  Generate locally with `openssl rand -hex 32`.

Already used by other parts of the flow:

- `CRON_SECRET` — gates `/api/cron/edge-prep` (shared with the existing crons).
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — Vercel KV access.
- `WHATSAPP_ALVIN_PHONE`, `WHATSAPP_ALVIN_KEY`, `WHATSAPP_KEN_PHONE`,
  `WHATSAPP_KEN_KEY` — for the WhatsApp ping on publish (via `/api/notify`).

### Sunday flow

1. **11:55 UTC** — `.github/workflows/edge-prep-cron.yml` hits
   `/api/cron/edge-prep`, which bakes 7d of trades + KV state into one JSON
   blob in KV under `edge_prep:YYYY-WW` and `edge_prep:current`.
2. **12:00 UTC** — the edge-mining agent reads `/api/edge-prep`, mines
   patterns, and commits `reports/weekly_edge_latest.md` (plus a
   per-week-tagged copy) to `main`.
3. **on push** — `.github/workflows/weekly-edge-publish.yml` reads the
   `_latest` report, extracts its week tag from the first-line HTML comment,
   signs the JSON body with `EDGE_HMAC_KEY`, and POSTs to `/api/edge-write`.
4. `/api/edge-write` stores the report under `weekly_edge:YYYY-WW`,
   updates the `weekly_edge:latest` pointer, and pings Alvin + Ken via
   `/api/notify`. The dashboard's Weekly tab pulls `/api/weekly-edge?week=latest`
   on activation.
