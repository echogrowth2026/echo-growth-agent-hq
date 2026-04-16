import { fork } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log("═══════════════════════════════════════════");
console.log("  ECHO GROWTH · AGENT HQ — Starting...");
console.log("═══════════════════════════════════════════");

// Start DASH agent
const dash = fork(join(__dirname, "dash-agent.js"));
dash.on("error", (e) => console.error("[LAUNCHER] DASH error:", e.message));
dash.on("exit", (code) => console.log(`[LAUNCHER] DASH exited with code ${code}`));

// Start CSM agent (only if bot token is set)
if (process.env.DISCORD_BOT_TOKEN) {
  const csm = fork(join(__dirname, "csm-agent.js"));
  csm.on("error", (e) => console.error("[LAUNCHER] CSM error:", e.message));
  csm.on("exit", (code) => console.log(`[LAUNCHER] CSM exited with code ${code}`));
  console.log("[LAUNCHER] CSM agent starting...");
} else {
  console.log("[LAUNCHER] No DISCORD_BOT_TOKEN — CSM agent skipped");
}

console.log("[LAUNCHER] All agents launched");
