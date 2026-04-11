# IE v6.2 Webhook Dashboard — Deployment Guide
## Deploy to Render.com (Free)

---

### STEP 1 — Push to GitHub

1. Create a free GitHub account at github.com if you don't have one
2. Create a new repository called `ie-webhook`
3. Upload these files to it:
   - `server.js`
   - `package.json`
   - `public/index.html`

---

### STEP 2 — Deploy on Render

1. Go to **render.com** → Sign up free
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub account → Select `ie-webhook` repo
4. Fill in:
   - **Name**: `ie-webhook` (or anything you like)
   - **Region**: Oregon (US West) — closest to market hours
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
5. Click **"Create Web Service"**
6. Wait ~2 minutes for deploy
7. Your URL will be: `https://ie-webhook.onrender.com` (or similar)

---

### STEP 3 — Update Pine Script Alerts

Replace your alert() strings as shown in `PINE_CHANGES.pine`.
Main change: add `"TICKER:" + syminfo.ticker + " "` at the start of each alert string.

---

### STEP 4 — Set Up TradingView Alerts

For EACH ticker you want (META, TSLA, SPY, etc.) on EACH timeframe (5m, 15m, 30m, 60m):

1. Open chart → Right-click → **"Add Alert"**
2. **Condition**: `IE v6.2 Rev13.6` → `Any alert() function call`
3. **Webhook URL**: `https://YOUR-RENDER-URL.onrender.com/webhook`
4. **Message**: Leave as default (Pine Script handles the message)
5. **Expiration**: Set to max (1 month or "Open-ended")
6. Click **Create**

---

### STEP 5 — Open Your Dashboard

Go to: `https://YOUR-RENDER-URL.onrender.com`

You'll see:
- Real-time alerts for all tickers/timeframes
- Color coded CALLS (green) / PUTS (red)
- Score, entry, SL, T1/T2/T3 levels
- Ticker heat map
- Toast notifications
- Optional sound alerts

---

### IMPORTANT NOTES

**Free Render tier spins down after 15 min inactivity.**
- First alert after idle may take 30-60 seconds to wake up
- To keep it always-on, upgrade to Render Starter ($7/mo) or use UptimeRobot (free) to ping your URL every 5 minutes

**UptimeRobot setup (free, keeps server awake):**
1. Go to uptimerobot.com → Free account
2. Add Monitor → HTTP(S)
3. URL: `https://YOUR-RENDER-URL.onrender.com/alerts`
4. Interval: every 5 minutes
5. Done — server stays awake

---

### YOUR WEBHOOK URL
`https://YOUR-RENDER-URL.onrender.com/webhook`

### YOUR DASHBOARD URL
`https://YOUR-RENDER-URL.onrender.com`
