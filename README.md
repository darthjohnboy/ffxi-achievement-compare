# FFXI Achievement Compare — standalone site: deploy guide

The compare page as a public site that is **not tied to Muse**. Static files
plus a small Google Apps Script that serves live XIchecklist syncs. No build
step, no framework, no server to pay for.

**Files in this folder**

| File | What it is |
|---|---|
| `index.html` | Page shell: leaderboard, crew board, who-has-what matrix, rules |
| `styles.css` | Dark Vana'diel theme |
| `app.js` | Scoring, merging, rendering, JSONP sync loader. **`API_URL` is the single constant at the top** — paste the Apps Script `/exec` URL there |
| `data/baseline.json` | Baseline data: FFXIAH snapshots from 2026-11-15 (jobs, crafts, relics, ranks, titles). Only changes when someone re-scrapes |
| `api/Code.gs` | Apps Script web app: reads the Google Form, checks keys, serves clean JSON |
| `test_site.js`, `test_codegs.js` | Verification harnesses (run with `node test_site.js` / `node test_codegs.js`) |

## Part 1 — GitHub Pages (the site)

1. Create a GitHub account if you don't have one, then create a **public**
   repository, e.g. `ffxi-achievement-compare`.
2. Upload everything in this folder **except** `api/` (the Apps Script lives
   on Google, not in the repo) and the `test_*.js` files (optional — harmless
   to include, but they aren't part of the site). So the repo root holds
   `index.html`, `styles.css`, `app.js`, and the `data/` folder.
3. Repo → Settings → Pages → Source: **Deploy from a branch**, branch
   `main`, folder `/ (root)`. Save.
4. After a minute or two the site is live at
   `https://<your-github-username>.github.io/ffxi-achievement-compare/`
   (all paths in the site are relative, so it also works under any repo
   subpath, and on Netlify / Cloudflare Pages if you'd rather use those).

At this point the site works on baseline data alone and says "Sync API not
configured". Part 2 wires up the live syncs.

## Part 2 — Apps Script (the live sync API)

1. Go to <https://script.google.com> (signed in as the Google account that
   owns the "FFXI Achievement Sync" form) and create a **New project**.
2. Delete the default `Code.gs` content and paste in `api/Code.gs` from
   this folder. Save (Ctrl+S / Cmd+S).
3. Set the player keys. Project Settings (gear icon) → **Script
   Properties** → Add property, one per player. The property **names** are:
   - `KEY_Darthjohnboy`
   - `KEY_Stoutheart`
   - `KEY_Enz`
   - `KEY_Jessse`
   - `KEY_Sidd`
   - `KEY_Makenshi`
   - `KEY_Derk`
   - `KEY_Meeze`
   - `KEY_Rajatia`
   - The **values** come from John's private key list (the one he generated
     for himself, plus the ones given to him in chat). **Never put a key
     value in the script, in the repo, or on the site.** If a player has no
     key set, their submissions are ignored. Rotate a key by changing its
     property value here — no site change needed.
4. Deploy → **New deployment** → type **Web app**.
   - Description: e.g. `FFXI Achievement Sync API`.
   - **Execute as: Me**
   - **Who has access: Anyone**
   - Deploy. Google will ask for permission the first time: the script needs
     to read the form's responses (`FormApp`) and the script properties.
     Accept.
5. Copy the **Web app URL** — it ends in `/exec`. Paste it into `app.js` as
   the `API_URL` constant at the top of the file, commit that one-line change
   to the repo, and wait a minute for Pages to rebuild.

## Part 3 — Test it

1. Open the site. John's card should show his synced data (608/1,058
   titles, RoE 461/1,109, missions 607/829, quests 435/1,111, warps 347/441)
   and **27,304 points, rank #1**, with a "Synced" pill and the 500-title
   badge. Stoutheart should be #2 at 17,767, Enz #3 at 12,900.
2. To confirm the fallback works: temporarily break the `API_URL` in
   `app.js` (or open the page with no network to Google). The page must
   still render the full baseline — Stoutheart #1 at 17,767, John #4 at
   8,996 — with a "Sync data unavailable" note and no errors. Restore the
   URL afterwards.
3. To confirm a new sync flows through: have a player zone in game (or run
   `//xic sync`), wait a few seconds, reload the site — their card updates
   with no site change. The script always serves each player's **latest**
   valid submission.
4. To test the key check: submit to the form with a wrong key and reload —
   the site must not change. (The Apps Script drops invalid-key submissions
   before serving anything.)

## How it stays fresh

- **Syncs:** automatic. Buddy zones → fork writes `*_sync.json` → helper
  POSTs it to the Google Form → the Apps Script serves the latest valid
  payload → the site picks it up on next load. Nobody touches the site.
- **Baseline (jobs / crafts / relics):** frozen at the 2026-11-15 FFXIAH
  scrape. It only changes when someone re-scrapes a player's FFXIAH page
  and updates `data/baseline.json` in the repo. REMA ownership is not in
  XIchecklist, so this is the only way relic counts move.
- **New buddy:** still comes through John — character name + server for the
  FFXIAH scrape (added to `data/baseline.json`), a per-player key added to
  Script Properties, and the fork installed on their PC. They then sync
  themselves.
- **Scoring changes:** edit the rates at the top of `app.js`
  (`TITLE_RATES`, `CHECK_RATES`) and the rules list in `index.html` so the
  displayed rules always match the code.

## Why JSONP, not fetch

Apps Script web apps send no CORS headers, so a plain `fetch()` from
another origin is blocked by the browser even for a simple GET. The site
therefore loads the API with a `<script>` tag (`?callback=...`), which is
not subject to CORS — see `loadLiveData()` in `app.js` and the callback
handling in `api/Code.gs`. The callback name is validated server-side, and
the script only ever serves data that passed the key check, with keys
stripped out.

## Troubleshooting

- **Site shows baseline only, "Sync API not configured":** `API_URL` in
  `app.js` is still empty — paste the `/exec` URL and redeploy the repo.
- **Site shows baseline only, "Sync data unavailable":** the Apps Script
  deployment is missing, not deployed as "Anyone", or the `/exec` URL is
  wrong. Open the `/exec` URL directly in a browser — it should show JSON.
  Appending `?callback=test` should show `test({...});`.
- **A player's sync never appears:** check (a) their key in Script
  Properties matches their config exactly (`KEY_<PlayerName>`), (b) their
  helper actually sent (file moved to `data\_sent\` on their PC), (c) the
  submission is in the form's Responses tab.
- **A sync appears but titles look short:** the form caps each submission
  at ~32,000 characters, so the detailed title list is truncated — the
  counts and per-group scores are complete; only the itemised list is
  partial. That is by design.
- **Wrong numbers on a card:** the site scores what the API serves. Check
  the raw payload in the form response (Payload field) before suspecting
  the site — and re-run `node test_site.js` to confirm the scoring code
  still reproduces the expected totals.
