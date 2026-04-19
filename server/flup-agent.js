import dotenv from "dotenv";
import cron from "node-cron";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { logActivity } from "./activity-log.js";

dotenv.config();

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const DISCORD_WEBHOOK = process.env.FLUP_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;

// ─── CONFIG ─────────────────────────────────────────────────────────
const BOOKING_LINK = "https://calendly.com/echogrowth/onboarding-call";
const WORKFLOW_14DAY_FOLLOWUP = "49edfee1-30d1-457a-9d75-3809c6b06061";
const STALE_THRESHOLD_HOURS = 48;
const DEAD_THRESHOLD_DAYS = 14;
const MAX_ACTIONS_PER_RUN = 25;

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
  } catch (e) { console.error("[FLUP] Pipeline fetch:", e.message); return []; }
}

// ─── ADD TAG ────────────────────────────────────────────────────────
async function addTag(contactId, tag) {
  try {
    await ghlFetch(`contacts/${contactId}/tags`, { method: "POST", body: { tags: [tag] } });
    return true;
  } catch (e) { console.error(`[FLUP] Tag error ${contactId}:`, e.message); return false; }
}

// ─── REMOVE TAG ─────────────────────────────────────────────────────
async function removeTag(contactId, tag) {
  try {
    await ghlFetch(`contacts/${contactId}/tags`, { method: "DELETE", body: { tags: [tag] } });
    return true;
  } catch (e) { return false; }
}

// ─── SEND SMS ───────────────────────────────────────────────────────
async function sendSMS(contactId, message) {
  try {
    await ghlFetch(`conversations/messages`, {
      method: "POST",
      body: {
        type: "SMS",
        contactId,
        message,
      },
    });
    console.log(`[FLUP] SMS sent to ${contactId}`);
    return true;
  } catch (e) {
    console.error(`[FLUP] SMS failed ${contactId}:`, e.message);
    return false;
  }
}

// ─── ADD TO WORKFLOW ────────────────────────────────────────────────
async function addToWorkflow(contactId, workflowId) {
  try {
    await ghlFetch(`contacts/${contactId}/workflow/${workflowId}`, {
      method: "POST",
      body: { eventStartTime: new Date().toISOString() },
    });
    console.log(`[FLUP] Added ${contactId} to workflow ${workflowId}`);
    return true;
  } catch (e) {
    console.error(`[FLUP] Workflow add failed ${contactId}:`, e.message);
    return false;
  }
}

// ─── UPDATE OPPORTUNITY STAGE ───────────────────────────────────────
async function updateOppStage(oppId, stageId) {
  try {
    await ghlFetch(`opportunities/${oppId}`, { method: "PUT", body: { pipelineStageId: stageId } });
    return true;
  } catch (e) { console.error(`[FLUP] Stage update failed ${oppId}:`, e.message); return false; }
}

// ─── UPDATE OPPORTUNITY STATUS ──────────────────────────────────────
async function updateOppStatus(oppId, status) {
  try {
    await ghlFetch(`opportunities/${oppId}`, { method: "PUT", body: { status } });
    return true;
  } catch (e) { console.error(`[FLUP] Status update failed ${oppId}:`, e.message); return false; }
}

// ─── FIND UNCONTACTED LEADS ─────────────────────────────────────────
async function findUncontactedLeads() {
  try {
    const pipelines = await getPipelines();
    const uncontacted = [];

    for (const pipeline of pipelines) {
      const newStages = (pipeline.stages || []).filter(s => {
        const name = s.name.toLowerCase();
        return name.includes("new lead") || name.includes("new client") || name.includes("double dial");
      });
      if (newStages.length === 0) continue;

      const data = await ghlFetch(`opportunities/search?location_id=${GHL_LOCATION_ID}`, {
        method: "POST", body: { locationId: GHL_LOCATION_ID, status: "open", limit: 100 },
      });

      for (const opp of (data.opportunities || [])) {
        if (newStages.some(s => s.id === opp.pipelineStageId)) {
          const addedTime = new Date(opp.createdAt).getTime();
          const hoursSince = (Date.now() - addedTime) / (60 * 60 * 1000);
          if (hoursSince > 24) {
            uncontacted.push({
              id: opp.id, contactId: opp.contact?.id,
              name: opp.contact?.name || opp.name || "Unknown",
              phone: opp.contact?.phone,
              pipeline: pipeline.name, stage: opp.pipelineStageName || "Unknown",
              hoursInStage: Math.floor(hoursSince),
            });
          }
        }
      }
    }
    return uncontacted;
  } catch (e) { console.error("[FLUP] Uncontacted scan:", e.message); return []; }
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
              id: event.id, contactId: event.contact?.id,
              name: event.contact?.name || "Unknown",
              phone: event.contact?.phone,
              calendarName: cal.name, scheduledTime: event.startTime,
              status: event.appointmentStatus,
            });
          }
        }
      } catch (e) { /* skip calendar */ }
    }
    return noShows;
  } catch (e) { console.error("[FLUP] No-show scan:", e.message); return []; }
}

// ─── FIND STALE LEADS ───────────────────────────────────────────────
async function findStaleLeads() {
  try {
    const data = await ghlFetch(`opportunities/search?location_id=${GHL_LOCATION_ID}`, {
      method: "POST", body: { locationId: GHL_LOCATION_ID, status: "open", limit: 100 },
    });

    const cutoff = Date.now() - (STALE_THRESHOLD_HOURS * 60 * 60 * 1000);
    const deadCutoff = Date.now() - (DEAD_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
    const stale = [];

    for (const opp of (data.opportunities || [])) {
      const lastUpdate = new Date(opp.updatedAt || opp.createdAt).getTime();
      if (lastUpdate < cutoff) {
        stale.push({
          id: opp.id, contactId: opp.contact?.id,
          name: opp.contact?.name || opp.name || "Unknown",
          phone: opp.contact?.phone,
          pipeline: opp.pipelineName || "Unknown",
          stage: opp.pipelineStageName || "Unknown",
          daysSinceActivity: Math.floor((Date.now() - lastUpdate) / (24 * 60 * 60 * 1000)),
          isDead: lastUpdate < deadCutoff,
        });
      }
    }
    return stale;
  } catch (e) { console.error("[FLUP] Stale scan:", e.message); return []; }
}

// ─── MORNING CHASE (9am) ────────────────────────────────────────────
async function runMorningChase() {
  console.log(`[FLUP] 🌅 Morning chase starting at ${new Date().toLocaleTimeString()}`);
  if (!GHL_API_KEY || !GHL_LOCATION_ID) return;

  const actions = [];
  let smsCount = 0, tagCount = 0, workflowCount = 0, deadCount = 0;

  // 1. Chase uncontacted leads
  const uncontacted = await findUncontactedLeads();
  console.log(`[FLUP] Found ${uncontacted.length} uncontacted leads (24+ hours)`);

  for (const lead of uncontacted.slice(0, MAX_ACTIONS_PER_RUN)) {
    // Tag them
    const tagged = await addTag(lead.contactId, "FLUP-chased");
    if (tagged) tagCount++;

    // Send SMS if they have a phone number
    if (lead.phone) {
      const smsText = `Hi ${lead.name?.split(" ")[0] || "there"}, thanks for your interest in Echo Growth! We'd love to chat about how we can help grow your business. Book a quick call here: ${BOOKING_LINK} — The Echo Growth Team`;
      const sent = await sendSMS(lead.contactId, smsText);
      if (sent) {
        smsCount++;
        actions.push(`📱 SMS sent to ${lead.name} (${lead.hoursInStage}h in ${lead.stage})`);
        await logActivity("FLUP", "SMS sent", `to ${lead.name} (${lead.stage})`);
      }
    }

    // Add to 14-day follow-up workflow
    if (WORKFLOW_14DAY_FOLLOWUP) {
      const enrolled = await addToWorkflow(lead.contactId, WORKFLOW_14DAY_FOLLOWUP);
      if (enrolled) {
        workflowCount++;
        actions.push(`🔄 ${lead.name} enrolled in 14-day follow-up workflow`);
      }
    }
  }

  // 2. Find stale leads and handle them
  const staleLeads = await findStaleLeads();
  console.log(`[FLUP] Found ${staleLeads.length} stale leads`);

  for (const lead of staleLeads.slice(0, MAX_ACTIONS_PER_RUN)) {
    if (lead.isDead) {
      // Mark as lost after 14+ days of no activity
      const updated = await updateOppStatus(lead.id, "lost");
      if (updated) {
        deadCount++;
        await addTag(lead.contactId, "auto-dead");
        actions.push(`💀 ${lead.name} marked as lost (${lead.daysSinceActivity} days inactive)`);
        await logActivity("FLUP", "marked dead", `${lead.name} (${lead.daysSinceActivity}d)`);
      }
    } else {
      // Tag stale leads for attention
      await addTag(lead.contactId, "stale-lead");

      // Send check-in SMS if they have a phone
      if (lead.phone && lead.daysSinceActivity <= 7) {
        const smsText = `Hi ${lead.name?.split(" ")[0] || "there"}, just checking in from Echo Growth. Still interested in growing your business? Happy to chat whenever suits: ${BOOKING_LINK}`;
        const sent = await sendSMS(lead.contactId, smsText);
        if (sent) {
          smsCount++;
          actions.push(`📱 Check-in SMS to ${lead.name} (${lead.daysSinceActivity} days stale)`);
        }
      }
    }
  }

  const report = {
    type: "morning", timestamp: new Date().toISOString(),
    uncontacted: uncontacted.length, staleLeads: staleLeads.length,
    smsCount, tagCount, workflowCount, deadCount,
    actions,
  };
  flupLog = [report, ...flupLog].slice(0, 50);
  await sendFlupReport(report);

  console.log(`[FLUP] ✓ Morning chase complete — ${smsCount} SMS, ${workflowCount} workflows, ${deadCount} marked dead`);
}

// ─── AFTERNOON RECOVERY (2pm) ───────────────────────────────────────
async function runAfternoonRecovery() {
  console.log(`[FLUP] 🌇 Afternoon recovery starting at ${new Date().toLocaleTimeString()}`);
  if (!GHL_API_KEY || !GHL_LOCATION_ID) return;

  const actions = [];
  let smsCount = 0, tagCount = 0;

  // Find no-shows
  const noShows = await findNoShows();
  console.log(`[FLUP] Found ${noShows.length} no-shows to recover`);

  for (const ns of noShows.slice(0, MAX_ACTIONS_PER_RUN)) {
    // Tag them
    const tagged = await addTag(ns.contactId, "no-show-chase");
    if (tagged) tagCount++;

    // Remove old "showed" tag if exists
    await removeTag(ns.contactId, "showed");

    // Send re-book SMS
    if (ns.phone) {
      const smsText = `Hi ${ns.name?.split(" ")[0] || "there"}, looks like we missed each other! No worries at all — grab another time here whenever suits: ${BOOKING_LINK} — Echo Growth`;
      const sent = await sendSMS(ns.contactId, smsText);
      if (sent) {
        smsCount++;
        actions.push(`📱 Re-book SMS to ${ns.name} (${ns.status} — ${ns.calendarName})`);
        await logActivity("FLUP", "no-show re-book", `${ns.name}`);
      }
    } else {
      actions.push(`🏷️ Tagged ${ns.name} as no-show-chase (no phone number)`);
    }
  }

  const report = {
    type: "afternoon", timestamp: new Date().toISOString(),
    noShows: noShows.length, smsCount, tagCount,
    uncontacted: 0, staleLeads: 0, workflowCount: 0, deadCount: 0,
    actions,
  };
  flupLog = [report, ...flupLog].slice(0, 50);
  await sendFlupReport(report);

  console.log(`[FLUP] ✓ Afternoon recovery complete — ${smsCount} re-book SMS sent`);
}

// ─── DISCORD REPORT ─────────────────────────────────────────────────
async function sendFlupReport(report) {
  if (!DISCORD_WEBHOOK) return;

  const isMorning = report.type === "morning";
  const embed = {
    title: `🔄 FLUP Agent — ${isMorning ? "Morning Chase" : "Afternoon Recovery"}`,
    color: isMorning ? 0x60A5FA : 0xFBBF24,
    fields: [],
    footer: { text: "ECHO GROWTH · AGENT HQ — FLUP Agent" },
    timestamp: new Date().toISOString(),
  };

  if (isMorning) {
    embed.fields.push(
      { name: "🆕 Uncontacted Leads", value: `**${report.uncontacted}** found (24+ hours)`, inline: true },
      { name: "⏳ Stale Leads", value: `**${report.staleLeads}** found (48+ hours)`, inline: true },
      { name: "📱 SMS Sent", value: `**${report.smsCount}** messages`, inline: true },
      { name: "🔄 Workflows Triggered", value: `**${report.workflowCount}** enrolled`, inline: true },
      { name: "💀 Marked Dead", value: `**${report.deadCount}** contacts (14+ days)`, inline: true },
      { name: "🏷️ Tags Applied", value: `**${report.tagCount}** contacts`, inline: true },
    );
  } else {
    embed.fields.push(
      { name: "📞 No-Shows Found", value: `**${report.noShows}** from today/yesterday`, inline: true },
      { name: "📱 Re-book SMS Sent", value: `**${report.smsCount}** messages`, inline: true },
      { name: "🏷️ Tags Applied", value: `**${report.tagCount}** contacts`, inline: true },
    );
  }

  if (report.actions.length > 0) {
    const actionText = report.actions.slice(0, 15).join("\n");
    embed.fields.push({ name: "✅ Actions Taken", value: actionText.substring(0, 1024), inline: false });
  } else {
    embed.fields.push({ name: "✅ Actions", value: "No actions needed — pipeline is clean", inline: false });
  }

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "FLUP Agent", embeds: [embed] }),
    });
    console.log("[FLUP] Discord report sent ✓");
  } catch (e) { console.error("[FLUP] Discord failed:", e.message); }
}

// ─── CRON ───────────────────────────────────────────────────────────
// Guarded so importing this module into DASH doesn't double-fire.
// FLUP writes to GHL (SMS, tags, workflow enrols) — a duplicate cron
// means duplicate outbound messages, which is why this guard matters.
const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  // 9am morning chase (8am UTC = 9am BST)
  cron.schedule("0 8 * * 1-5", () => runMorningChase());
  // 2pm afternoon recovery (1pm UTC = 2pm BST)
  cron.schedule("0 13 * * 1-5", () => runAfternoonRecovery());
  console.log("[FLUP Agent] Started — 9am chase · 2pm recovery · Mon-Fri");
  console.log(`[FLUP Agent] Booking link: ${BOOKING_LINK}`);
  console.log(`[FLUP Agent] 14-day workflow: ${WORKFLOW_14DAY_FOLLOWUP}`);
}

export { runMorningChase, runAfternoonRecovery, flupLog };
