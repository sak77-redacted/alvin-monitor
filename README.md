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

A long-running routine mines pattern edges from the last 7 days of realised trades, journals, and rule violations, then publishes a markdown report to the Weekly tab (📈 panel) and pings WhatsApp.

### Sunday flow

1. **11:55 UTC** — `.github/workflows/edge-prep-cron.yml` curls `/api/cron/edge-prep` (Bearer `CRON_SECRET`). The endpoint aggregates trades/journal/samples/violations/regime-history/hour-of-day buckets and writes to KV under `edge_prep:YYYY-WW` (60d TTL) and `edge_prep:current`.
2. **12:00 UTC** — the edge-mining agent runs, reads `/api/edge-prep?week=current`, computes bucket-significance, writes `reports/weekly_edge_YYYY-WW.md` **and** an identical `reports/weekly_edge_latest.md`, and pushes to `main`.
3. **on push** — `.github/workflows/weekly-edge-publish.yml` fires on changes to `reports/weekly_edge_latest.md`. It reads the `<!-- week: YYYY-WW -->` comment on line 1, builds a JSON body, signs it with HMAC-SHA256(EDGE_HMAC_KEY), and POSTs to `/api/edge-write`. That endpoint verifies the signature, writes `weekly_edge:YYYY-WW` and bumps `weekly_edge:latest` in KV, then fires a single WhatsApp summary to Alvin + Ken.
4. **dashboard** — the Weekly tab's "📈 Weekly Edge Report" panel reads `/api/weekly-edge?week=latest` on render and renders the markdown inline.

### Required env vars

**New (must be set before the first Sunday)**

- `EDGE_HMAC_KEY` — random 32-byte hex (e.g. `openssl rand -hex 32`). The **same value** must be set in:
  - Vercel project env (used by `api/edge-write.js` to verify)
  - GitHub repo secret (used by `weekly-edge-publish.yml` to sign)

**Optional**

- `DEPLOY_HOST` (GitHub repo secret) — defaults to `https://alvin-monitor.vercel.app`. Set it if the deploy hostname differs.

**Existing (already configured for the other crons; reused here)**

- `CRON_SECRET` — bearer secret for `api/cron/edge-prep`
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — Vercel KV (Upstash)
- `WHATSAPP_ALVIN_PHONE` / `WHATSAPP_ALVIN_KEY` / `WHATSAPP_KEN_PHONE` / `WHATSAPP_KEN_KEY` — CallMeBot push for the summary WhatsApp

### Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/api/cron/edge-prep` | POST | `Authorization: Bearer ${CRON_SECRET}` | Sunday-11:55 aggregator → KV |
| `/api/edge-prep?week=current\|YYYY-WW` | GET | public | Reads the prep blob the agent consumes |
| `/api/edge-write` | POST | `X-Signature: sha256=<hmac>` | Receives signed reports from the publish workflow |
| `/api/weekly-edge?week=latest\|YYYY-WW` | GET | public | Reads the rendered markdown for the dashboard |
