# Tempo — Internet Speed Test

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
index.html      the page structure
style.css       all styling (responsive, mobile-first friendly)
script.js       the test logic (fetch/XHR based, no libraries)
vercel.json     small static-hosting config (security headers, clean URLs)
```

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
   git commit -m "Tempo speed test"
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

## Notes & customization

- **Test sizes**: adjustable from the "Test settings" panel on the page
  (Quick / Standard / Thorough), or change the `<option>` values in
  `index.html`.
- **Auto-start**: the settings panel has an "Auto-start on page load" toggle
  (saved in `localStorage`).
- **Branding**: the logo/wordmark ("tempo") and colors are original — this
  isn't a clone of Netflix's FAST.com assets, just a similar minimal layout
  (big number, progress ring, latency/upload detail row, settings link).
  Swap colors in the `:root` block at the top of `style.css`, and the SVG
  mark in `index.html`, to match your own brand.
- **If a corporate/network firewall blocks `speed.cloudflare.com`**, the test
  will show "Could not reach the test server." Cloudflare's endpoint is
  public and typically not blocked, but some restrictive networks filter it.
