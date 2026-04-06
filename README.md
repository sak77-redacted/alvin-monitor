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
