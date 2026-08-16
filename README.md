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

An automated routine mines edge patterns from the last 7d of realized trading outcomes each Sunday and posts a markdown report to the dashboard's Weekly tab (plus a WhatsApp ping to both operators).

Flow:

1. **11:55 UTC** — `.github/workflows/edge-prep-cron.yml` curls `/api/cron/edge-prep`, which aggregates trades/journal/samples/violations/hourly buckets/regime history into a single JSON blob at KV key `edge_prep:current`.
2. **12:00 UTC** — the scheduled edge-mining agent (configured at https://claude.ai/code/routines) reads `/api/edge-prep`, buckets by hour-of-day, market, regime, and size band, then commits `reports/weekly_edge_YYYY-WW.md` + `reports/weekly_edge_latest.md` to `main`.
3. **push trigger** — `.github/workflows/weekly-edge-publish.yml` fires on any push touching `reports/weekly_edge_latest.md`, extracts the ISO-week tag from the file's `<!-- week: YYYY-WW -->` header comment, HMAC-signs `{week, markdown, summary}`, and POSTs to `/api/edge-write`. That writes to KV under `weekly_edge:<week>` and pings both operators.

### Required env vars

- **`EDGE_HMAC_KEY`** — new. Add to Vercel project env **and** as a GitHub repo secret with the identical value. Generate with `openssl rand -hex 32`.

### Reused env vars

- `CRON_SECRET` — same secret as the other cron endpoints; gates `/api/cron/edge-prep`.
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` — Vercel KV credentials.
- `WHATSAPP_ALVIN_PHONE` + `WHATSAPP_ALVIN_KEY` + `WHATSAPP_KEN_PHONE` + `WHATSAPP_KEN_KEY` — CallMeBot credentials used by the publish notification.
- Optional: GitHub secret `DEPLOY_HOST` — overrides the default `https://alvin-monitor.vercel.app` for both workflows.

### Endpoints

- `GET /api/cron/edge-prep` (auth: `Authorization: Bearer $CRON_SECRET` or `?secret=$CRON_SECRET`) — refreshes `edge_prep:current`.
- `GET /api/edge-prep?week=current|YYYY-WW` — public read of the aggregate blob.
- `POST /api/edge-write` (auth: `X-Signature: sha256=<hmac-sha256(EDGE_HMAC_KEY, raw-body)>`) — writes the weekly report + notifies.
- `GET /api/weekly-edge?week=latest|YYYY-WW` — public read of the rendered report; the dashboard's Weekly Edge panel consumes this.

### Exit criteria

The routine tracks a cumulative count of significant-pattern weeks across the last 8 reports; three consecutive weeks with no significant pattern surfaces an exit-approaching banner in the report.
