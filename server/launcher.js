import { fork } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log("═══════════════════════════════════════════════");
console.log("  ECHO GROWTH · AGENT HQ");
console.log("  Starting all agents...");
console.log("═══════════════════════════════════════════════");

function startAgent(name, file) {
  const proc = fork(join(__dirname, file));
  proc.on("error", (e) => console.error(`[LAUNCHER] ${name} error:`, e.message));
  proc.on("exit", (code) => {
    console.error(`[LAUNCHER] ${name} exited (code ${code}) — restarting in 10s...`);
    setTimeout(() => startAgent(name, file), 10000);
  });
  console.log(`[LAUNCHER] ${name} started ✓`);
  return proc;
}

// ─── CORE (HTTP server) ─────────────────────────────────────────────
startAgent("DASH", "dash-agent.js");

// ─── DISCORD BOT ────────────────────────────────────────────────────
if (process.env.DISCORD_BOT_TOKEN) {
  startAgent("CSM", "csm-agent.js");
} else {
  console.log("[LAUNCHER] CSM skipped — no DISCORD_BOT_TOKEN");
}

// ─── AUTONOMOUS AGENTS (GHL writers + watchers) ─────────────────────
startAgent("FLUP", "flup-agent.js");
startAgent("AUTO", "auto-agent.js");
startAgent("OPS", "ops-agent.js");
startAgent("CMMS", "cmms-agent.js");

// ─── GENERATIVE / ANALYTICAL AGENTS (AI-driven) ─────────────────────
startAgent("COPY", "copy-agent.js");
startAgent("CRTV", "crtv-agent.js");
startAgent("STRT", "strt-agent.js");
startAgent("FUNL", "funl-agent.js");
startAgent("ADLIB", "adlib-agent.js");
startAgent("ADSPY", "adspy-agent.js");
startAgent("ADGEN", "adgen-agent.js");

// ─── NEW: AUTOMATION BUILDERS + CONTENT ─────────────────────────────
// N8N is on-demand only (no cron), but we fork it so its module is
// loaded and ready for the launcher to monitor like any other. LinkedIn
// has a daily 8am cron.
startAgent("N8N", "n8n-agent.js");
startAgent("LINKEDIN", "linkedin-agent.js");

// ─── KB REFRESH (72h cron, runs initial refresh on boot) ────────────
startAgent("KB-REFRESH", "csm-kb-refresh.js");

// ─── MORNING BRIEF (daily 09:00 Europe/London) ──────────────────────
startAgent("BRIEF", "csm-morning-brief.js");

console.log("═══════════════════════════════════════════════");
console.log("  17 agents launched + Jarvis brain mounted on DASH");
console.log("═══════════════════════════════════════════════");
