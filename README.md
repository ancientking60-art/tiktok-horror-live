# TikTok Horror Live (hosted)

Interactive horror rain + jump-scare overlay for **TikTok LIVE**.

Designed to run as a free **Render** web service. You open a link — no Windows install, no `.bat` file.

| Event | Scare |
|--------|--------|
| Viewer joins | Instant jump scare (~3s), throttled |
| Rose / 1-coin gift | Instant jump scare |
| Bigger gift | 20s slow build-up, then scare |

Scares queue so they never overlap. Gifts beat joins.

---

## Deploy on Render

1. Push this folder to a GitHub repo
2. On [render.com](https://render.com) → **New → Web Service** → connect the repo  
   (or use the included `render.yaml` Blueprint)
3. Runtime: **Node**. Build: `npm install`. Start: `npm start`
4. Free plan is fine. Health check path: `/health`
5. After deploy, open:

```
https://YOUR-APP.onrender.com/control.html?user=YOUR_TIKTOK_NAME
https://YOUR-APP.onrender.com/player.html?user=YOUR_TIKTOK_NAME
```

Put the **player** URL into TikTok LIVE Studio as a Browser / Link source at **1080 × 1920**, with audio on.

### Free-tier sleep

Render free services sleep after ~15 minutes with no traffic. The first request after sleep can take ~50 seconds. Open `/health` or the control page a minute before you go live, or keep a cheap uptime ping on `/health`.

---

## Local run (optional)

```bash
npm install
npm start
```

Then open `http://localhost:3847/control.html?user=YOUR_TIKTOK_NAME`  
(`PORT` env var overrides the default `3847`.)

---

## How to use on stream

1. Go LIVE on TikTok
2. Open the **control** link and click **Connect** (or load player with `?user=` — it connects itself)
3. Add the **player** link as a Browser source in LIVE Studio
4. Click the player once if sound is muted
5. Test with **Simulate Join / Rose / Big Gift** before relying on real gifts

---

## Event rules (defaults)

- Instant scare cooldown ~8s (joins respect this; roses still preferred)
- Join throttle ~20s
- Build-up is never interrupted; extras wait in queue
- Name caption like `@name summoned her…` (toggle in control)

---

## Limits

- TikTok must be **LIVE** for real events
- Uses open-source `tiktok-live-connector` (no login to *read* chat). TikTok can change APIs; update the package if Connect breaks
- One active TikTok connection per server instance
- Keep your control URL private if you care who can simulate scares
