import dotenv from "dotenv";
import cron from "node-cron";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { logActivity } from "./activity-log.js";
import { postToDiscord } from "./discord-post.js";

dotenv.config();

const DISCORD_WEBHOOK = process.env.OPS_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;
const DASH_API = process.env.DASH_API || "https://echo-growth-agent-hq-production.up.railway.app";

let opsLog = [];
let agentStatus = {};

// ─── AGENT CADENCE EXPECTATIONS ─────────────────────────────────────
// Each child agent is expected to log SOMETHING to the shared activity
// feed within a window of its normal schedule. If we don't see any
// entry from an agent inside its window, it gets flagged as silent in
// the verbose OPS report. Windows are generous (≈ 1.5× the slowest
// expected interval) to avoid noise from missed single runs.
//
// `onDemand: true` agents don't have a schedule — we just surface the
// "last seen" timestamp in the report rather than flagging silence.
const AGENT_CADENCE = [
  // Hourly-ish during business hours
  { name: "AUTO",     maxSilentMs:      90 * 60 * 1000, label: "hourly" },
  { name: "CMMS",     maxSilentMs:      45 * 60 * 1000, label: "15-min" },
  // Twice-daily (9am + 2pm)
  { name: "FLUP",     maxSilentMs: 14 * 60 * 60 * 1000, label: "twice-daily" },
  // Daily agents
  { name: "COPY",     maxSilentMs: 26 * 60 * 60 * 1000, label: "daily" },
  { name: "CRTV",     maxSilentMs: 26 * 60 * 60 * 1000, label: "daily" },
  { name: "FUNL",     maxSilentMs: 26 * 60 * 60 * 1000, label: "daily" },
  { name: "ADLIB",    maxSilentMs: 26 * 60 * 60 * 1000, label: "daily" },
  { name: "ADSPY",    maxSilentMs: 26 * 60 * 60 * 1000, label: "daily" },
  { name: "LINKEDIN", maxSilentMs: 26 * 60 * 60 * 1000, label: "daily" },
  // Weekly
  { name: "STRT",     maxSilentMs:  8 * 24 * 60 * 60 * 1000, label: "weekly" },
  // On-demand — no silence flag, just report last-seen
  { name: "ADGEN",    onDemand: true, label: "on-demand" },
  { name: "N8N",      onDemand: true, label: "on-demand" },
];

async function fetchAgentActivity(limit = 200) {
  try {
    const res = await fetch(`${DASH_API}/api/agents/activity?limit=${limit}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.activity) ? data.activity : [];
  } catch { return []; }
}

function fmtAge(ms) {
  if (ms == null) return "never";
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function checkChildAgents() {
  const activity = await fetchAgentActivity(200);
  const now = Date.now();
  const byAgent = new Map();
  for (const entry of activity) {
    const a = entry.agent;
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
    if (!a || !ts) continue;
    const prev = byAgent.get(a);
    if (!prev || ts > prev.ts) byAgent.set(a, { ts, action: entry.action, details: entry.details });
  }

  const silent = [];
  const checks = [];
  for (const cfg of AGENT_CADENCE) {
    const last = byAgent.get(cfg.name);
    const ageMs = last ? now - last.ts : null;

    if (cfg.onDemand) {
      checks.push({
        agent: cfg.name,
        status: "ok",
        message: last ? `(${cfg.label}) last: ${fmtAge(ageMs)}` : `(${cfg.label}) never seen`,
      });
      continue;
    }

    if (!last) {
      silent.push({ agent: cfg.name, label: cfg.label, age: "never" });
      checks.push({ agent: cfg.name, status: "warning", message: `(${cfg.label}) no activity recorded` });
      continue;
    }

    if (ageMs > cfg.maxSilentMs) {
      silent.push({ agent: cfg.name, label: cfg.label, age: fmtAge(ageMs) });
      checks.push({ agent: cfg.name, status: "warning", message: `(${cfg.label}) silent ${fmtAge(ageMs)}` });
    } else {
      checks.push({ agent: cfg.name, status: "ok", message: `(${cfg.label}) ok · ${fmtAge(ageMs)}` });
    }
  }
  return { checks, silent };
}

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

  // Keep DASH / DASH-DATA checks as inline fields (the two core checks
  // that existed before this expansion). Child-agent checks — which
  // can be 10+ in one run — go into a single block field to avoid
  // hitting Discord's 25-field cap.
  const coreChecks = report.checks.filter(c => c.agent === "DASH" || c.agent === "DASH-DATA");
  const childChecks = report.checks.filter(c => c.agent !== "DASH" && c.agent !== "DASH-DATA");

  const embed = {
    title: `${allOk ? "🟢" : hasErrors ? "🔴" : "🟡"} OPS Agent — System Status`,
    color: allOk ? 0x34D399 : hasErrors ? 0xEF4444 : 0xFBBF24,
    description: allOk ? "All systems operational" : "Issues detected — see below",
    fields: coreChecks.map(c => ({
      name: `${c.status === "ok" ? "✅" : c.status === "warning" ? "⚠️" : "❌"} ${c.agent}`,
      value: c.message,
      inline: true,
    })),
    footer: { text: "ECHO GROWTH · AGENT HQ — OPS Agent" },
    timestamp: new Date().toISOString(),
  };

  if (childChecks.length > 0) {
    const lines = childChecks
      .map(c => `${c.status === "ok" ? "✅" : c.status === "warning" ? "⚠️" : "❌"} **${c.agent}** — ${c.message}`)
      .join("\n")
      .substring(0, 1024);
    embed.fields.push({ name: "🤖 Child Agents", value: lines || "—", inline: false });
  }

  if ((report.silent || []).length > 0) {
    const lines = report.silent
      .map(s => `⚠️ ${s.agent} silent for ${s.age} (expected ${s.label})`)
      .join("\n")
      .substring(0, 1024);
    embed.fields.push({ name: "🔕 Silent Agents", value: lines, inline: false });
  }

  if (report.actions.length > 0) {
    embed.fields.push({ name: "🔧 Actions Taken", value: report.actions.join("\n"), inline: false });
  }

  await postToDiscord("OPS", { username: "OPS Agent", embeds: [embed] });
  console.log("[OPS] Discord report sent ✓");
}

// ─── MAIN OPS RUN ───────────────────────────────────────────────────
async function runOpsAgent(verbose = false) {
  console.log(`[OPS] Running health check at ${new Date().toLocaleTimeString()}`);

  const checks = [];
  const actions = [];

  // Check DASH core
  const dashHealth = await checkDashHealth();
  const dashData = await checkDashData();
  checks.push(dashHealth, dashData);

  // Check every child agent's activity cadence. Report only, no
  // restart attempts — the launcher already auto-restarts crashed
  // children after 10s; silence usually means a cron didn't fire or
  // a logActivity call is missing from a new code path, not a dead
  // process.
  const { checks: childChecks, silent } = await checkChildAgents();
  checks.push(...childChecks);

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
    checks, actions, silent,
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
// Guarded so importing this module into DASH doesn't double-fire
// the schedulers. Only the launcher's forked child hits `isMain`.
const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  // Every 5 minutes — silent unless issues
  cron.schedule("*/5 * * * *", () => { runOpsAgent(false); });
  // Daily ops report at 8am (verbose)
  cron.schedule("0 7 * * 1-5", () => {
    console.log("[OPS] Daily health report...");
    runOpsAgent(true);
  });
  console.log("[OPS Agent] Started — 5-min health checks · Daily report 8am");
}

export { runOpsAgent, opsLog };
