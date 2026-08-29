# FasterNET — Internet Speed Test

A small, dependency-free internet speed test with a clean, minimal layout
inspired by fast.com. Pure HTML/CSS/JS — no build step, no framework.

It measures:
- **Latency** (unloaded and loaded/under-load, in ms)
- **Download speed** (Mbps)
- **Upload speed** (Mbps)

using Cloudflare's free, CORS-enabled speed test endpoints
(`speed.cloudflare.com/__down` and `/__up`), plus [ipwho.is](https://ipwho.is)
for the client IP/ISP line. No API keys, no backend, no server needed.

## Files

```
index.html      the page structure (incl. the About/FAQ popup)
style.css       all styling (responsive, mobile-first friendly)
script.js       the test logic (fetch/XHR based, no libraries)
vercel.json     small static-hosting config (security headers, clean URLs)
```

## Behavior

- **Auto-start**: the test begins automatically 2 seconds after the page
  finishes loading. Clicking the play button before then starts it
  immediately instead.
- **Home** (top-left nav): scrolls back to the top of the page.
- **About** (top-right nav): opens a popup with the FAQ content, closable via
  the × button, the Escape key, or clicking outside the popup.
- **Settings** (bottom bar, gear icon): configure the test —
  - *Parallel connections* — Min/Max number of simultaneous streams. The
    test ramps up from Min toward Max over the course of the run.
  - *Test duration (seconds)* — Min/Max bounds. The test stops once the
    measurement stabilizes after the minimum, or unconditionally at the
    maximum.
  - *Measure loaded latency during upload* — also samples ping while the
    upload is running (in addition to during download), for a more complete
    bufferbloat picture.
  - *Always show all metrics* — keeps the latency/upload detail row visible
    even before a test has run.
  - *Save config for this device* — persists your settings in
    `localStorage` so they're applied on your next visit.
  - Buttons: **Reset** (back to defaults: 1–8 connections, 5–30s),
    **Save** (apply, and persist if the checkbox above is on), **Cancel**
    (discard changes).

## Run it locally

Just open `index.html` in a browser, or serve the folder with any static
server, e.g.:

```bash
npx serve .
```

## Deploy: GitHub → Vercel

1. **Create a new GitHub repo** and push these files:
   ```bash
   git init
   git add .
   git commit -m "FasterNET speed test"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```

2. **Import into Vercel**:
   - Go to [vercel.com/new](https://vercel.com/new)
   - Select your GitHub repo
   - Framework preset: **Other** (it's a static site — no build command needed)
   - Leave "Build Command" and "Output Directory" blank
   - Click **Deploy**

That's it — Vercel will serve `index.html` at your project's root URL, and
every future push to `main` redeploys automatically.

## Notes

- **Server(s) line**: this build tests against Cloudflare's global network,
  which auto-routes you to your nearest edge — it doesn't expose a
  city-by-city server list the way some commercial tools do, so that line
  is shown as a single honest entry rather than fabricated city names.
- **Branding**: the "FasterNET" logo/wordmark and colors are original.
  Swap colors in the `:root` block at the top of `style.css`, and the SVG
  mark in `index.html`, to match your own brand.
- **If a corporate/network firewall blocks `speed.cloudflare.com`**, the test
  will show "Could not reach the test server." Cloudflare's endpoint is
  public and typically not blocked, but some restrictive networks filter it.
