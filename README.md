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

## Weekly Edge Mining

A long-running Claude Code routine ("edge-mining-weekly") fires every Sunday 20:00 HKT (12:00 UTC) and writes `reports/weekly_edge_YYYY-WW.md` + `reports/weekly_edge_latest.md` summarising the past 7d of realised P&L, journal entries, and rule violations into the dashboard's Weekly tab.

### Sunday flow

1. **11:55 UTC** — `edge-prep-cron.yml` curls `/api/cron/edge-prep` (Bearer-auth with `CRON_SECRET`). The handler snapshots last-7d trades, journal, approvals/audit, samples, hourly P&L buckets, and regime history into KV at `edge_prep:YYYY-WW` (60d TTL) + `edge_prep:current` (14d TTL).
2. **12:00 UTC** — Claude Code routine reads `/api/edge-prep?week=current`, mines bucket-significance, writes the markdown report to `reports/`, commits to `main`.
3. **on push to `reports/weekly_edge_latest.md`** — `weekly-edge-publish.yml` extracts the week tag from line 1's `<!-- week: YYYY-WW -->` comment, HMAC-signs the body with `EDGE_HMAC_KEY`, and POSTs to `/api/edge-write`. That endpoint writes to KV and pings Ken via CallMeBot WhatsApp.

### Required env vars

New (this feature):

- `EDGE_HMAC_KEY` — random 32+ byte secret. **Must be identical** in Vercel project env and GitHub repo secrets. Generate with `openssl rand -hex 32`.

Already in use elsewhere; these endpoints reuse them:

- `CRON_SECRET` — Bearer-auth for `/api/cron/edge-prep`. Same value as the other crons.
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` — Vercel KV.
- `WHATSAPP_KEN_PHONE` + `WHATSAPP_KEN_KEY` — CallMeBot push to Ken (the weekly edge is a Ken-only notification, like the Monday digest).

Optional GH repo secret:

- `DEPLOY_HOST` — override the default `https://alvin-monitor.vercel.app` if the project is renamed.
