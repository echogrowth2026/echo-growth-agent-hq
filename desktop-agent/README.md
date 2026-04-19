# Echo Desktop Agent

Local companion for Echo Growth Agent HQ. Runs on Sam's PC, connects to the
Railway backend via WebSocket, executes filtered local actions (Puppeteer
browser control, file read/write, shell commands).

## First-time setup

```powershell
cd C:\Users\reill\Documents\echo-growth-agent-hq\desktop-agent
npm install
npm start
```

Puppeteer downloads Chromium on first `npm install` (~180 MB). Subsequent
runs are instant.

## How login works

The agent launches Chromium with a dedicated `userDataDir`
(`C:\Users\reill\AppData\Local\EchoDesktopAgent\ChromeData`). This is a
separate profile from Chrome's default — Chrome can keep running with your
normal profile alongside the agent's Chromium window.

**First login per service is manual.** When Jarvis says "log into LinkedIn",
the agent navigates Chromium to linkedin.com and Sam finishes the login in
that window. Cookies persist in the userDataDir so subsequent sessions
reuse them.

## Security model

- Runs only when you start it manually
- Filtered file access: allowlist in `config.json`
- Filtered shell: whitelist of command prefixes, blocklist of tokens, no shell interpolation
- Optional `DESKTOP_AUTH_TOKEN` env var for WebSocket auth
- Close the app = instant disconnect

## Tray controls

Right-click the tray icon for quick service opens (GHL / n8n / LinkedIn /
Discord) or to quit. The window can be hidden to the tray.

## Extending

Edit `config.json`:
- `allowedDirs` — directories the file-access module can read/write
- `allowedCommandPrefixes` — shell commands allowed via `RUN_COMMAND`
- `blockedPatterns` — patterns blocked even within allowed prefixes
- `services.*` — URLs opened by `OPEN_URL` / `LOGIN` / quick-open

For new browser actions, edit `agent/browser-control.js`. LinkedIn
selectors are fragile (LinkedIn rewrites their UI frequently) — expect to
revisit the selector list.
