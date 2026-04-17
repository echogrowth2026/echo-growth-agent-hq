import dotenv from "dotenv";
import cron from "node-cron";

dotenv.config();

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const DASH_API = process.env.DASH_API || "https://echo-growth-agent-hq-production.up.railway.app";

let flupLog = [];

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

// ─── GET PIPELINES ──────────────────────────────────────────────────
async function getPipelines() {
  try {
    const data = await ghlFetch(`opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    return data.pipelines || [];
  } catch (e) { console.error("[FLUP] Pipeline fetch error:", e.message); return []; }
}

// ─── FIND STALE LEADS (no activity in 48+ hours) ────────────────────
async function findStaleLeads() {
  try {
    const pipelines = await getPipelines();
    const staleLeads = [];
    const cutoff = Date.now() - (48 * 60 * 60 * 1000); // 48 hours ago

    for (const pipeline of pipelines) {
      const data = await ghlFetch(`opportunities/search?location_id=${GHL_LOCATION_ID}`, {
        method: "POST", body: { locationId: GHL_LOCATION_ID, pipeline_id: pipeline.id, status: "open", limit: 100 },
      });

      for (const opp of (data.opportunities || [])) {
        const lastUpdate = new Date(opp.updatedAt || opp.createdAt).getTime();
        if (lastUpdate < cutoff) {
          staleLeads.push({
            id: opp.id,
            contactId: opp.contact?.id,
            name: opp.contact?.name || opp.name || "Unknown",
            pipeline: pipeline.name,
            stage: opp.pipelineStageName || "Unknown",
            lastActivity: opp.updatedAt,
            daysSinceActivity: Math.floor((Date.now() - lastUpdate) / (24 * 60 * 60 * 1000)),
          });
        }
      }
    }

    return staleLeads;
  } catch (e) {
    console.error("[FLUP] Stale lead scan error:", e.message);
    return [];
  }
}

// ─── FIND NO-SHOWS ──────────────────────────────────────────────────
async function findNoShows() {
  try {
    const calendars = await ghlFetch(`calendars/?locationId=${GHL_LOCATION_ID}`);
    const calList = calendars.calendars || [];
    if (calList.length === 0) return [];

    const noShows = [];
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(0, 0, 0, 0);

    for (const cal of calList) {
      try {
        const appts = await ghlFetch(
          `calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${cal.id}&startTime=${yesterday.getTime()}&endTime=${now.getTime()}`
        );
        for (const event of (appts.events || [])) {
          if (event.appointmentStatus === "no_show" || event.appointmentStatus === "cancelled") {
            noShows.push({
              id: event.id,
              contactId: event.contact?.id,
              name: event.contact?.name || "Unknown",
              calendarName: cal.name,
              scheduledTime: event.startTime,
              status: event.appointmentStatus,
            });
          }
        }
      } catch (e) { /* skip calendar */ }
    }

    return noShows;
  } catch (e) {
    console.error("[FLUP] No-show scan error:", e.message);
    return [];
  }
}

// ─── FIND NEW LEADS NOT YET CONTACTED ───────────────────────────────
async function findUncontactedLeads() {
  try {
    const pipelines = await getPipelines();
    const uncontacted = [];

    for (const pipeline of pipelines) {
      // Find stages that suggest new/uncontacted leads
      const newStages = pipeline.stages?.filter(s => {
        const name = s.name.toLowerCase();
        return name.includes("new lead") || name.includes("new client") || name.includes("double dial");
      }) || [];

      if (newStages.length === 0) continue;

      const data = await ghlFetch(`opportunities/search?location_id=${GHL_LOCATION_ID}`, {
        method: "POST", body: { locationId: GHL_LOCATION_ID, pipeline_id: pipeline.id, status: "open", limit: 100 },
      });

      for (const opp of (data.opportunities || [])) {
        if (newStages.some(s => s.id === opp.pipelineStageId)) {
          const addedTime = new Date(opp.createdAt).getTime();
          const hoursSinceAdded = (Date.now() - addedTime) / (60 * 60 * 1000);
          if (hoursSinceAdded > 24) { // More than 24 hours in "new lead" stage
            uncontacted.push({
              id: opp.id,
              contactId: opp.contact?.id,
              name: opp.contact?.name || opp.name || "Unknown",
              pipeline: pipeline.name,
              stage: opp.pipelineStageName || "Unknown",
              hoursInStage: Math.floor(hoursSinceAdded),
            });
          }
        }
      }
    }

    return uncontacted;
  } catch (e) {
    console.error("[FLUP] Uncontacted scan error:", e.message);
    return [];
  }
}

// ─── ADD TAG TO CONTACT ─────────────────────────────────────────────
async function addTag(contactId, tag) {
  try {
    await ghlFetch(`contacts/${contactId}/tags`, {
      method: "POST", body: { tags: [tag] },
    });
    return true;
  } catch (e) {
    console.error(`[FLUP] Tag error for ${contactId}:`, e.message);
    return false;
  }
}

// ─── UPDATE OPPORTUNITY STAGE ───────────────────────────────────────
async function updateOppStage(oppId, stageId) {
  try {
    await ghlFetch(`opportunities/${oppId}`, {
      method: "PUT", body: { pipelineStageId: stageId },
    });
    return true;
  } catch (e) {
    console.error(`[FLUP] Stage update error for ${oppId}:`, e.message);
    return false;
  }
}

// ─── DISCORD REPORT ─────────────────────────────────────────────────
async function sendFlupReport(report) {
  if (!DISCORD_WEBHOOK) return;

  const embed = {
    title: `🔄 FLUP Agent — ${report.type === "morning" ? "Morning Chase" : "Afternoon Recovery"}`,
    color: 0x60A5FA,
    fields: [
      { name: "📋 Stale Leads Found", value: `**${report.staleLeads}** contacts with no activity in 48+ hours`, inline: true },
      { name: "📞 No-Shows Found", value: `**${report.noShows}** no-shows to rebook`, inline: true },
      { name: "🆕 Uncontacted Leads", value: `**${report.uncontacted}** leads sitting 24+ hours without contact`, inline: true },
      { name: "✅ Actions Taken", value: report.actions.length > 0 ? report.actions.slice(0, 10).join("\n") : "No actions needed", inline: false },
    ],
    footer: { text: "ECHO GROWTH · AGENT HQ — FLUP Agent" },
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "FLUP Agent", embeds: [embed] }),
    });
    console.log("[FLUP] Discord report sent ✓");
  } catch (e) { console.error("[FLUP] Discord failed:", e.message); }
}

// ─── MAIN FLUP RUN ──────────────────────────────────────────────────
async function runFlupAgent(type = "morning") {
  console.log(`[FLUP] Running ${type} scan at ${new Date().toLocaleTimeString()}`);
  if (!GHL_API_KEY || !GHL_LOCATION_ID) { console.error("[FLUP] Missing env vars"); return; }

  const actions = [];

  // 1. Find stale leads
  const staleLeads = await findStaleLeads();
  console.log(`[FLUP] Found ${staleLeads.length} stale leads`);

  for (const lead of staleLeads.slice(0, 20)) { // Process max 20 at a time
    const tagged = await addTag(lead.contactId, "FLUP-chased");
    if (tagged) {
      actions.push(`› Tagged "${lead.name}" as FLUP-chased (${lead.daysSinceActivity} days stale in ${lead.stage})`);
    }
  }

  // 2. Find no-shows (afternoon run)
  let noShows = [];
  if (type === "afternoon") {
    noShows = await findNoShows();
    console.log(`[FLUP] Found ${noShows.length} no-shows`);

    for (const ns of noShows.slice(0, 10)) {
      const tagged = await addTag(ns.contactId, "no-show-chase");
      if (tagged) {
        actions.push(`› Tagged "${ns.name}" as no-show-chase (${ns.calendarName})`);
      }
    }
  }

  // 3. Find uncontacted leads (morning run)
  let uncontacted = [];
  if (type === "morning") {
    uncontacted = await findUncontactedLeads();
    console.log(`[FLUP] Found ${uncontacted.length} uncontacted leads (24+ hours)`);

    for (const lead of uncontacted.slice(0, 20)) {
      const tagged = await addTag(lead.contactId, "needs-contact");
      if (tagged) {
        actions.push(`› Tagged "${lead.name}" as needs-contact (${lead.hoursInStage}h in ${lead.stage})`);
      }
    }
  }

  // Log
  const report = {
    type, timestamp: new Date().toISOString(),
    staleLeads: staleLeads.length,
    noShows: noShows.length,
    uncontacted: uncontacted.length,
    actions,
  };
  flupLog = [report, ...flupLog].slice(0, 50);

  // Send Discord report
  await sendFlupReport(report);

  console.log(`[FLUP] ✓ Complete — ${actions.length} actions taken`);
  return report;
}

// ─── CRON JOBS ──────────────────────────────────────────────────────
// 9am morning chase (8am UTC = 9am BST)
cron.schedule("0 8 * * 1-5", () => {
  console.log("[FLUP] 9am morning chase...");
  runFlupAgent("morning");
});

// 2pm afternoon recovery (1pm UTC = 2pm BST)
cron.schedule("0 13 * * 1-5", () => {
  console.log("[FLUP] 2pm afternoon recovery...");
  runFlupAgent("afternoon");
});

console.log("[FLUP Agent] Started — 9am chase · 2pm recovery · Mon-Fri");

export { runFlupAgent, flupLog };
