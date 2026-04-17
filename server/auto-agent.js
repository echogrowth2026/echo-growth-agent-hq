import dotenv from "dotenv";
import cron from "node-cron";

dotenv.config();

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;

let autoLog = [];

// ─── GHL v2 API ─────────────────────────────────────────────────────
async function ghlFetch(endpoint, options = {}) {
  const method = options.method || "GET";
  const body = options.body || null;
  const res = await fetch(`https://services.leadconnectorhq.com/${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, "Content-Type": "application/json", Version: "2021-07-28" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`GHL ${res.status} ${endpoint} — ${t}`); }
  return res.json();
}

// ─── CHECK PIPELINE HEALTH ──────────────────────────────────────────
async function checkPipelineHealth() {
  const issues = [];
  try {
    const data = await ghlFetch(`opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    const pipelines = data.pipelines || [];

    for (const pipeline of pipelines) {
      if (!pipeline.stages || pipeline.stages.length === 0) {
        issues.push({ type: "warning", message: `Pipeline "${pipeline.name}" has no stages configured` });
      }
    }

    console.log(`[AUTO] Pipeline check: ${pipelines.length} pipelines, ${issues.length} issues`);
  } catch (e) {
    issues.push({ type: "error", message: `Pipeline check failed: ${e.message}` });
  }
  return issues;
}

// ─── CHECK CONTACT TAG CONSISTENCY ──────────────────────────────────
async function checkTagConsistency() {
  const issues = [];
  try {
    const data = await ghlFetch(`contacts/?locationId=${GHL_LOCATION_ID}&limit=100`);
    const contacts = data.contacts || [];

    // Check for contacts with conflicting tags
    for (const contact of contacts) {
      const tags = contact.tags || [];
      const name = contact.contactName || `${contact.firstName || ""} ${contact.lastName || ""}`.trim();

      // Check for conflicting statuses
      if (tags.includes("qualified") && tags.includes("unqualified")) {
        issues.push({ type: "warning", message: `"${name}" has both 'qualified' and 'unqualified' tags`, contactId: contact.id });
      }
      if (tags.includes("no-show") && tags.includes("showed")) {
        issues.push({ type: "warning", message: `"${name}" has both 'no-show' and 'showed' tags`, contactId: contact.id });
      }
    }

    console.log(`[AUTO] Tag check: ${contacts.length} contacts scanned, ${issues.length} conflicts`);
  } catch (e) {
    issues.push({ type: "error", message: `Tag check failed: ${e.message}` });
  }
  return issues;
}

// ─── CHECK CALENDAR HEALTH ──────────────────────────────────────────
async function checkCalendarHealth() {
  const issues = [];
  try {
    const data = await ghlFetch(`calendars/?locationId=${GHL_LOCATION_ID}`);
    const calendars = data.calendars || [];

    if (calendars.length === 0) {
      issues.push({ type: "warning", message: "No calendars configured — bookings won't work" });
    }

    for (const cal of calendars) {
      if (!cal.isActive) {
        issues.push({ type: "info", message: `Calendar "${cal.name}" is inactive` });
      }
    }

    console.log(`[AUTO] Calendar check: ${calendars.length} calendars, ${issues.length} issues`);
  } catch (e) {
    issues.push({ type: "error", message: `Calendar check failed: ${e.message}` });
  }
  return issues;
}

// ─── CHECK FOR STUCK CONTACTS ───────────────────────────────────────
async function checkStuckContacts() {
  const issues = [];
  try {
    const pipeData = await ghlFetch(`opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    const pipelines = pipeData.pipelines || [];

    for (const pipeline of pipelines) {
      const data = await ghlFetch(`opportunities/search?location_id=${GHL_LOCATION_ID}`, {
        method: "POST", body: { locationId: GHL_LOCATION_ID, pipeline_id: pipeline.id, status: "open", limit: 100 },
      });

      const opps = data.opportunities || [];
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

      const stuckCount = opps.filter(o => {
        const updated = new Date(o.updatedAt || o.createdAt).getTime();
        return updated < sevenDaysAgo;
      }).length;

      if (stuckCount > 10) {
        issues.push({
          type: "warning",
          message: `${stuckCount} contacts stuck 7+ days in "${pipeline.name}" — FLUP should chase`,
        });
      }
    }
  } catch (e) {
    issues.push({ type: "error", message: `Stuck contact check failed: ${e.message}` });
  }
  return issues;
}

// ─── FIX: REMOVE CONFLICTING TAGS ───────────────────────────────────
async function fixConflictingTags(contactId, tagToRemove) {
  try {
    await ghlFetch(`contacts/${contactId}/tags`, {
      method: "DELETE", body: { tags: [tagToRemove] },
    });
    return true;
  } catch (e) {
    console.error(`[AUTO] Tag fix failed for ${contactId}:`, e.message);
    return false;
  }
}

// ─── DISCORD REPORT ─────────────────────────────────────────────────
async function sendAutoReport(report) {
  if (!DISCORD_WEBHOOK) return;

  const statusIcon = report.totalIssues === 0 ? "🟢" : report.errors > 0 ? "🔴" : "🟡";
  const embed = {
    title: `${statusIcon} AUTO Agent — System Health Check`,
    color: report.totalIssues === 0 ? 0x34D399 : report.errors > 0 ? 0xEF4444 : 0xFBBF24,
    fields: [
      { name: "Pipeline Health", value: `${report.pipelineIssues} issue${report.pipelineIssues !== 1 ? "s" : ""}`, inline: true },
      { name: "Tag Conflicts", value: `${report.tagIssues} conflict${report.tagIssues !== 1 ? "s" : ""}`, inline: true },
      { name: "Calendar Health", value: `${report.calendarIssues} issue${report.calendarIssues !== 1 ? "s" : ""}`, inline: true },
      { name: "Stuck Contacts", value: `${report.stuckIssues} flag${report.stuckIssues !== 1 ? "s" : ""}`, inline: true },
    ],
    footer: { text: "ECHO GROWTH · AGENT HQ — AUTO Agent" },
    timestamp: new Date().toISOString(),
  };

  if (report.details.length > 0) {
    embed.fields.push({
      name: "📋 Details",
      value: report.details.slice(0, 8).map(d => `${d.type === "error" ? "🔴" : d.type === "warning" ? "🟡" : "ℹ️"} ${d.message}`).join("\n"),
      inline: false,
    });
  }

  if (report.fixes.length > 0) {
    embed.fields.push({ name: "🔧 Auto-Fixes Applied", value: report.fixes.join("\n"), inline: false });
  }

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "AUTO Agent", embeds: [embed] }),
    });
    console.log("[AUTO] Discord report sent ✓");
  } catch (e) { console.error("[AUTO] Discord failed:", e.message); }
}

// ─── MAIN AUTO RUN ──────────────────────────────────────────────────
async function runAutoAgent() {
  console.log(`[AUTO] Running health check at ${new Date().toLocaleTimeString()}`);
  if (!GHL_API_KEY || !GHL_LOCATION_ID) { console.error("[AUTO] Missing env vars"); return; }

  const allIssues = [];
  const fixes = [];

  // Run all checks
  const pipelineIssues = await checkPipelineHealth();
  const tagIssues = await checkTagConsistency();
  const calendarIssues = await checkCalendarHealth();
  const stuckIssues = await checkStuckContacts();

  allIssues.push(...pipelineIssues, ...tagIssues, ...calendarIssues, ...stuckIssues);

  // Auto-fix conflicting tags
  for (const issue of tagIssues) {
    if (issue.contactId && issue.message.includes("unqualified")) {
      const fixed = await fixConflictingTags(issue.contactId, "unqualified");
      if (fixed) fixes.push(`› Removed 'unqualified' tag from conflicting contact`);
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    totalIssues: allIssues.length,
    errors: allIssues.filter(i => i.type === "error").length,
    pipelineIssues: pipelineIssues.length,
    tagIssues: tagIssues.length,
    calendarIssues: calendarIssues.length,
    stuckIssues: stuckIssues.length,
    details: allIssues,
    fixes,
  };

  autoLog = [report, ...autoLog].slice(0, 50);
  await sendAutoReport(report);

  console.log(`[AUTO] ✓ Complete — ${allIssues.length} issues, ${fixes.length} fixes`);
  return report;
}

// ─── CRON: Hourly health check during business hours ────────────────
cron.schedule("0 7-18 * * 1-5", () => {
  runAutoAgent();
});

console.log("[AUTO Agent] Started — Hourly health checks Mon-Fri 8am-7pm");

export { runAutoAgent, autoLog };
