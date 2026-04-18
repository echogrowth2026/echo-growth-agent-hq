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

// ─── CORE ───────────────────────────────────────────────────────────
startAgent("DASH", "dash-agent.js");

// ─── DISCORD BOT ────────────────────────────────────────────────────
if (process.env.DISCORD_BOT_TOKEN) {
  startAgent("CSM", "csm-agent.js");
} else {
  console.log("[LAUNCHER] CSM skipped — no DISCORD_BOT_TOKEN");
}

// ─── AUTONOMOUS AGENTS ──────────────────────────────────────────────
startAgent("FLUP", "flup-agent.js");
startAgent("AUTO", "auto-agent.js");
startAgent("OPS", "ops-agent.js");
startAgent("CMMS", "cmms-agent.js");

console.log("═══════════════════════════════════════════════");
console.log("  6 agents launched — system operational");
console.log("═══════════════════════════════════════════════");
