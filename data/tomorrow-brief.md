# Tomorrow Brief — Overnight Cleanup Run

Sam — here's what I did while you slept. Seven commits landed on `main` locally, nothing pushed. You review, you push. I've also flagged a few things I noticed in passing.

## What I changed

| # | Commit | Summary |
|---|---|---|
| 1 | `8d87ca1` | Pricing refs in `copy-agent` / `adgen-agent` moved from $6k to $8k / 90 days. CRTV team roster swapped from Kieran/Mason/Eric to Sam/Ollie/Elliott (assumption flagged below). |
| 2 | `37f56ba` | `ops-agent`, `flup-agent`, `cmms-agent` crons now wrapped in the `isMain` guard — importing any of them into DASH no longer double-fires schedules. Matches the fix I did on `auto-agent` earlier. |
| 3 | `b2539cf` | Deleted `server/command-router.js` and `server/computer-access.js`. Both were orphaned — no frontend / agent / Jarvis intent called them. `/api/computer/status` is still mounted but returns browserStatus only. |
| 4 | `321a440` | New diagnostic at `server/diagnostics/dash-data-audit.js` + `GET /api/diagnostics/data-audit`. Compares DASH's cached snapshot against a fresh GHL pull, writes a markdown diff report to `server/data/diagnostics/`. On-demand only, no cron. |
| 5 | `fb1c80d` | `ghl_switch_subaccount` now fuzzy-matches subaccount names across four tiers (case-sensitive → case-insensitive → spaces-stripped → normalised substring). Logs the winning tier to the console so you can see which strategy hit. Additive — old exact matches still win first. |
| 6 | `bb69bf0` | OPS now checks every child agent's last activity against expected cadence. Silent agents land in a new "🔕 Silent Agents" Discord embed field in the daily verbose report. No auto-restart — report only. |
| 7 | `d1e2bde` | `GET /api/review-queue/stats` — single unified count of pending items across COPY / CRTV / ADGEN / N8N / AUTO / LINKEDIN with oldest-age per agent and the overall oldest item. No UI. |

## Things I noticed while working

- **`server/browser.js` is dead weight.** `getBrowser()` / `getGHLPage()` / `queueBrowserTask()` are exported and never called — the desktop companion does all the real browser work now. Only `browserStatus()` is still used (by `/api/computer/status`). You can probably delete the whole file, move `browserStatus` inline into dash-agent, and drop `puppeteer-core` from the root `package.json` — Railway only needs `ws`. I left it alone because deleting it felt like it crossed the "don't touch working things" line at 2 am.
- **`/api/computer/status` route** I kept after deleting the other `/api/computer/*` routes. No known caller. If nothing hits it by next cleanup, delete.
- **`data/diagnostics/` will accumulate forever.** Every `GET /api/diagnostics/data-audit` call writes a new `data-audit-<ISO>.md`. I didn't add retention. Easy win: cap to the last 30 files on each write.
- **LinkedIn post selectors in `desktop-agent/templates/linkedin_post.js`** are fragile (I flagged this when I wrote them). LinkedIn rewrites their UI regularly. If Jarvis's `post on linkedin saying…` ever starts failing with `waitForAny failed …`, check the most recent screenshot in `desktop-agent/logs/errors/` before assuming auth broke.
- **CRTV team swap was a judgment call.** Your instruction was "Sam (TikTok + strategy), Elliott, Ollie" but didn't specify which format each owns. I assumed Sam → Reels + TikTok (both short-form, matches "TikTok + strategy"), Ollie → YouTube Shorts (storytelling fits execution role), Elliott → face-to-camera (authority / client-facing). If that's wrong, swap names in `server/crtv-agent.js` lines 31–36 and the prompt block around line 82.
- **OPS silent-agent thresholds are my guesses.** In particular: `STRT` runs weekly so I set its window to 8 days, and `ADGEN`/`N8N` are on-demand so I don't flag silence at all — just report last-seen. If you'd rather see "ADGEN silent 5 days" as a nudge, move them out of `onDemand: true` in `server/ops-agent.js`.
- **Review queue stats** omits CMMS. CMMS drafts only post to Discord — there's no reviewable store backing them. If you want CMMS in the breakdown, we'd need to persist CMMS drafts to a queue first.
- **`server/adspy-agent.js`** produces its competitive intel from OpenAI's training knowledge only — no real scraping. I didn't touch it, but worth knowing: the "niches" it analyses come from your pipeline names, so if you rename `Default` → `Direwolf SEO / Law Firms` the output will become more specific.

## First thing to do tomorrow evening

Hit `GET https://echo-growth-agent-hq-production.up.railway.app/api/diagnostics/data-audit` after pushing. Confirms the new endpoint is wired, writes a fresh audit report to `server/data/diagnostics/`, and tells you whether DASH's cache is actually tracking the live GHL numbers. If `stalenessSec > 900` during business hours, the 15-min refresh cron isn't firing — worth investigating before anything else.

## Questions for you

1. **CRTV roster split** — Sam=Reels+TikTok, Ollie=YT Shorts, Elliott=face-to-camera. Keep or swap?
2. **OPS thresholds** — any agent too lax or too strict? The 26-hour daily window catches single-miss noise but hides a 2-day silence. Comfortable with that?
3. **Delete `server/browser.js`** on the next pass? If yes I'll also drop `puppeteer-core` from the root package.json.
4. **CMMS in review stats** — add a persistence layer so CMMS drafts show up, or leave CMMS Discord-only?
5. **`/api/computer/status` route** — kill it next round, or keep as a heartbeat for the desktop companion's Puppeteer state?

## Blockers hit

None. Every task landed clean.

## Commits ready for review

```
d1e2bde [OVERNIGHT-7] Add review queue stats endpoint
bb69bf0 [OVERNIGHT-6] Expand OPS to monitor all 13 child agents
fb1c80d [OVERNIGHT-5] Add fuzzy subaccount name matching
321a440 [OVERNIGHT-4] Add DASH data accuracy diagnostic
b2539cf [OVERNIGHT-3] Remove dead code: command-router + computer-access
37f56ba [OVERNIGHT-2] Add isMain guards to prevent double-cron
8d87ca1 [OVERNIGHT-1] Fix stale pricing and team roster in agent configs
```

`git log --oneline -10` gives the full picture. `git status` is clean. Nothing pushed — go for it when you've reviewed.
