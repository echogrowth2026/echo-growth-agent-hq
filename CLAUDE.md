# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Frontend (Vite SPA — AgentRoom visualisation)
npm run dev        # dev server
npm run preview    # preview a built bundle

# Backend (production entrypoint used by Railway)
npm start          # runs server/launcher.js — forks all agents
```

There are no tests, linter, or type checker configured. A second `server/package.json` exists with a `"start": "node server/dash-agent.js"` script — it is not used by the root `npm start` and appears to be a legacy artefact; prefer the root `package.json`.

## Architecture

This is a two-part system: a **Node backend of cooperating agents** and a **React frontend** that visualises them. The backend is deployed to Railway at `https://echo-growth-agent-hq-production.up.railway.app`; that URL is hardcoded in `src/AgentRoom.jsx` and as the default `DASH_API` in `server/csm-agent.js` and `server/ops-agent.js`.

### Process model (`server/launcher.js`)

`npm start` forks each agent as a child process. On exit, the launcher auto-restarts it after 10s. CSM is only launched if `DISCORD_BOT_TOKEN` is set; all others always launch. All agents share the same env (`.env` at repo root, loaded via `dotenv` in each agent).

### Agents and their responsibilities

- **DASH** (`dash-agent.js`) — The only agent that runs an **HTTP server** (Express, `PORT` env or 3001). It is the single source of truth for GHL data: pulls contacts, pipelines, opportunities, bookings, conversations, caches them in memory (`dashCache`), and exposes them via `/api/dash`, `/api/dash/refresh`, `/api/dash/lookup/:name`, `/api/dash/pipelines`, `/api/dash/briefings`, `/api/health`. Morning (6am) and EOD (10pm) cron jobs push Discord embeds; refresh runs every 15 min during business hours.
- **CSM** (`csm-agent.js`) — Discord bot (`discord.js`) that listens in `MONITORED_CHANNELS`, uses OpenAI `gpt-4o-mini` for a **two-stage flow**: first a `shouldRespondAI` triage call decides RESPOND vs SKIP (unless directly @mentioned), then a response is generated using `KNOWLEDGE_BASE` + live DASH data + per-client context fetched from `/api/dash/lookup/:name`. Hardcoded `GUILD_ID` and `TEST_CHANNEL_ID` at the top of the file. Escalation keywords trigger a DM to the guild owner (`SAM_USER_ID`).
- **FLUP** (`flup-agent.js`) — **Takes write actions** against GHL: tags contacts, sends SMS, enrols contacts in workflow `WORKFLOW_14DAY_FOLLOWUP`, marks stale opps as `lost`. Two crons: 9am BST morning chase (uncontacted + stale leads), 2pm afternoon recovery (no-shows). `MAX_ACTIONS_PER_RUN = 25` caps blast radius per run — respect this when extending.
- **AUTO** (`auto-agent.js`) — Hourly GHL system health checks (pipeline stages, tag conflicts, calendar health, stuck contacts). Auto-fixes some tag conflicts.
- **OPS** (`ops-agent.js`) — Meta-agent: polls DASH's `/api/health` and `/api/dash` every 5 min. On DASH error, tries to `POST /api/dash/refresh` as a self-heal. Only posts to Discord when something is wrong or during the daily 8am verbose report.
- **CMMS** (`cmms-agent.js`) — 15-min inbox scans; drafts OpenAI replies for unread GHL conversations but does not auto-send (`autoSend: false`).

### Data flow

```
GHL API ──► DASH (cache + REST) ──► CSM (Discord bot)
                                ──► OPS (health checks)
                                ──► Frontend (AgentRoom.jsx polls /api/dash every 60s)

GHL API ◄── FLUP / AUTO / CMMS (direct writes, no DASH dependency)

Discord webhook ◄── every agent posts embeds under its own username
```

### GHL API conventions

Every agent defines its own `ghlFetch` helper against `https://services.leadconnectorhq.com/` with `Version: 2021-07-28` and `Authorization: Bearer ${GHL_API_KEY}`. When adding new GHL calls, mirror this pattern — do **not** introduce a shared client; each agent is fully self-contained so the launcher can restart any one in isolation.

### Environment variables

`.env` at repo root. Keys referenced across agents:

- `GHL_API_KEY`, `GHL_LOCATION_ID` — required by DASH, FLUP, AUTO, CMMS
- `DISCORD_WEBHOOK` — used by every agent for embed reporting
- `DISCORD_BOT_TOKEN` — CSM only; absence disables CSM cleanly
- `OPENAI_API_KEY` — CSM and CMMS; absence disables AI features gracefully
- `DASH_API` — overrides the hardcoded Railway URL for CSM and OPS (useful for local dev)
- `PORT` — DASH Express port (Railway sets this)

### Frontend

Single-file React app (`src/AgentRoom.jsx`) — a 2D top-down "office" visualisation of agents moving between rooms. Purely presentational; its only data dependency is `GET /api/dash` polled every 60s. Inline styles throughout; no CSS files, no component library, no routing.
