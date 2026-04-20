# Moneywize on Vercel — Deploy Guide

Single project hosts both the frontend (`index.html`) and the backend (`api/analyze.js`). No more split between Netlify + Cloudflare.

## What's in this folder

```
moneywize-vercel/
├── index.html          ← YOU ADD THIS (your current v11 HTML, with ONE line changed)
├── api/
│   └── analyze.js      ← Serverless function, calls Claude (replaces Cloudflare Worker)
├── vercel.json         ← Config (60s function timeout)
└── README.md           ← This file
```

## Step 1 — Drop in your HTML

1. Copy your current `moneywize` HTML (the v11 file you deployed to Netlify) into this folder
2. Rename it to **`index.html`** (Vercel uses that as the homepage by default)
3. Open it in a text editor and find this line:

   ```js
   const WORKER_URL = 'https://wys-api.basilabraham78.workers.dev';
   ```

4. Replace it with:

   ```js
   const WORKER_URL = '/api/analyze';
   ```

   That's a relative path — it now points to the Vercel function living on the same domain. No more CORS issues.

5. Save.

## Step 2 — Deploy to Vercel

Pick the easiest option:

### Option A — Drag & drop (simplest, like Netlify Drop)

1. Zip this entire folder (`moneywize-vercel.zip`)
2. Go to **https://vercel.com/new**
3. Sign in (GitHub, Google, or email)
4. Click **"Upload"** or drag the zip in
5. On the setup screen, leave everything default and click **Deploy**

### Option B — Vercel CLI (slightly faster for future updates)

```bash
npm i -g vercel
cd moneywize-vercel
vercel
```

Follow the prompts (accept defaults). First deploy takes ~30 seconds.

### Option C — GitHub integration (best for iteration)

1. Push this folder to a GitHub repo
2. At **vercel.com/new**, import the repo
3. Auto-deploys on every git push

## Step 3 — Add the Claude API key as an env variable

After the first deploy, you'll see your project dashboard.

1. Click **Settings** → **Environment Variables**
2. Add:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** your Claude API key (from `console.anthropic.com` → Settings → API Keys)
   - **Environments:** tick all three (Production, Preview, Development)
3. Click **Save**
4. Go back to **Deployments** → click the three dots on the latest one → **Redeploy** (this pulls in the new env var)

## Step 4 — Pick a domain

On the project **Overview** page, you'll see your URL — something like `moneywize-xyz.vercel.app`.

To customize it:
1. **Settings** → **Domains**
2. Either use a `.vercel.app` subdomain (free, instant) or add your own custom domain

## Verifying it works

1. Open your Vercel URL
2. Upload a PDF bank statement
3. Watch the browser dev-tools Network tab — you should see a POST to `/api/analyze` returning 200
4. If anything fails, check **Vercel dashboard → Logs** for the function — errors show up there with stack traces

## Cost reality check

- **Vercel Hobby tier** — free, plenty for personal use. 100 GB bandwidth/month, unlimited function invocations (fair-use).
- **Claude API** — same as before, you pay per token. A typical statement extraction costs ~$0.02–0.05 at current Sonnet pricing.

## Rollback plan

If anything goes sideways, your Netlify + Cloudflare setup at `moneywize.netlify.app` still works. This is a parallel deploy, not a replacement until you're ready.
