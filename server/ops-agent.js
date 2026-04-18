import dotenv from "dotenv";
import cron from "node-cron";
import { logActivity } from "./activity-log.js";

dotenv.config();

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const DASH_API = process.env.DASH_API || "https://echo-growth-agent-hq-production.up.railway.app";

let opsLog = [];
let agentStatus = {};

// ─── CHECK AGENT HEALTH ─────────────────────────────────────────────
async function checkDashHealth() {
  try {
    const res = await fetch(`${DASH_API}/api/health`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { agent: "DASH", status: "error", message: `HTTP ${res.status}` };
    const data = await res.json();
    const lastUpdate = data.lastUpdated ? new Date(data.lastUpdated) : null;
    const minutesSinceUpdate = lastUpdate ? (Date.now() - lastUpdate.getTime()) / 60000 : Infinity;

    if (minutesSinceUpdate > 30) {
      return { agent: "DASH", status: "warning", message: `Last update ${Math.floor(minutesSinceUpdate)}m ago` };
    }
    return { agent: "DASH", status: "ok", message: `Running, last update ${Math.floor(minutesSinceUpdate)}m ago` };
  } catch (e) {
    return { agent: "DASH", status: "error", message: `Unreachable: ${e.message}` };
  }
}

async function checkDashData() {
  try {
    const res = await fetch(`${DASH_API}/api/dash`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { agent: "DASH-DATA", status: "error", message: `HTTP ${res.status}` };
    const data = await res.json();

    const checks = [];
    if (!data.leads) checks.push("leads missing");
    if (!data.opportunities) checks.push("opportunities missing");
    if (!data.bookings) checks.push("bookings missing");
    if (!data.conversations) checks.push("conversations missing");

    if (checks.length > 0) {
      return { agent: "DASH-DATA", status: "warning", message: `Incomplete: ${checks.join(", ")}` };
    }
    return { agent: "DASH-DATA", status: "ok", message: `All data streams active` };
  } catch (e) {
    return { agent: "DASH-DATA", status: "error", message: `Data check failed: ${e.message}` };
  }
}

// ─── DISCORD REPORT ─────────────────────────────────────────────────
async function sendOpsReport(report) {
  if (!DISCORD_WEBHOOK) return;

  const allOk = report.checks.every(c => c.status === "ok");
  const hasErrors = report.checks.some(c => c.status === "error");

  const embed = {
    title: `${allOk ? "🟢" : hasErrors ? "🔴" : "🟡"} OPS Agent — System Status`,
    color: allOk ? 0x34D399 : hasErrors ? 0xEF4444 : 0xFBBF24,
    description: allOk ? "All systems operational" : "Issues detected — see below",
    fields: report.checks.map(c => ({
      name: `${c.status === "ok" ? "✅" : c.status === "warning" ? "⚠️" : "❌"} ${c.agent}`,
      value: c.message,
      inline: true,
    })),
    footer: { text: "ECHO GROWTH · AGENT HQ — OPS Agent" },
    timestamp: new Date().toISOString(),
  };

  if (report.actions.length > 0) {
    embed.fields.push({ name: "🔧 Actions Taken", value: report.actions.join("\n"), inline: false });
  }

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "OPS Agent", embeds: [embed] }),
    });
    console.log("[OPS] Discord report sent ✓");
  } catch (e) { console.error("[OPS] Discord failed:", e.message); }
}

// ─── MAIN OPS RUN ───────────────────────────────────────────────────
async function runOpsAgent(verbose = false) {
  console.log(`[OPS] Running health check at ${new Date().toLocaleTimeString()}`);

  const checks = [];
  const actions = [];

  // Check all agents
  const dashHealth = await checkDashHealth();
  const dashData = await checkDashData();
  checks.push(dashHealth, dashData);

  // Store status
  for (const check of checks) {
    const prev = agentStatus[check.agent];
    agentStatus[check.agent] = check;

    // Detect state changes
    if (prev && prev.status === "ok" && check.status !== "ok") {
      actions.push(`› ${check.agent} went from OK → ${check.status.toUpperCase()}`);
    }
    if (prev && prev.status !== "ok" && check.status === "ok") {
      actions.push(`› ${check.agent} recovered → OK`);
    }
  }

  // Auto-repair: if DASH is down, try to trigger a refresh
  if (dashHealth.status === "error") {
    try {
      await fetch(`${DASH_API}/api/dash/refresh`, { method: "POST", signal: AbortSignal.timeout(15000) });
      actions.push("› Attempted DASH refresh");
    } catch (e) { actions.push("› DASH refresh failed — manual intervention needed"); }
  }

  const report = {
    timestamp: new Date().toISOString(),
    checks, actions,
    allOk: checks.every(c => c.status === "ok"),
  };

  opsLog = [report, ...opsLog].slice(0, 100);

  // Only send Discord report if there are issues or it's a verbose (daily) check
  const hasIssues = !report.allOk || actions.length > 0;
  if (hasIssues || verbose) {
    await sendOpsReport(report);
  }

  if (!report.allOk || actions.length > 0) {
    await logActivity("OPS", report.allOk ? "healed" : "issue detected", actions[0] || `${checks.length} checks`);
  }
  console.log(`[OPS] ✓ ${checks.length} checks — ${report.allOk ? "ALL OK" : "ISSUES DETECTED"}`);
  return report;
}

// ─── CRON ───────────────────────────────────────────────────────────
// Every 5 minutes — silent unless issues
cron.schedule("*/5 * * * *", () => { runOpsAgent(false); });

// Daily ops report at 8am (verbose)
cron.schedule("0 7 * * 1-5", () => {
  console.log("[OPS] Daily health report...");
  runOpsAgent(true);
});

console.log("[OPS Agent] Started — 5-min health checks · Daily report 8am");

export { runOpsAgent, opsLog };
