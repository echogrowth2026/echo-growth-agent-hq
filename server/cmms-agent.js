import dotenv from "dotenv";
import cron from "node-cron";
import { logActivity } from "./activity-log.js";

dotenv.config();

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let cmmsLog = [];
let lastCheckedTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 mins ago on start

// Tracks {oppId -> lastStageName} so we only send milestones on transitions.
const seenStages = new Map();
// Tracks {oppId+milestone -> true} to prevent duplicate milestone sends.
const sentMilestones = new Set();
// Tracks {contactId -> lastChaseTimestamp} for asset chase throttling.
const lastChaseAt = new Map();

const MILESTONES = [
  { key: "welcome",  match: ["day 1", "welcome", "kickoff", "onboarding start"], sms: "Welcome to Echo Growth! 🎉 Your system build has officially started. You'll get updates at each milestone. Questions? Drop them in Discord anytime. — Echo Growth Team" },
  { key: "strategy", match: ["day 3", "strategy complete", "strategy done", "strategy approved"], sms: "Milestone unlocked ✅ Your strategy doc is finalised. Next up: build begins. We'll be in touch within 48 hours with scripts + creative direction. — Echo Growth Team" },
  { key: "build",    match: ["day 7", "build in progress", "in build", "construction"], sms: "Quick update: your system build is well underway. Ads, funnel and automations are being configured. Expect launch-ready status within a few days. — Echo Growth Team" },
  { key: "launch",   match: ["day 10", "launch ready", "ready to launch", "go live"], sms: "You're launch-ready 🚀 Everything's built, tested and ready to go live. We'll reach out to confirm go-live. — Echo Growth Team" },
];

const ASSET_WAIT_MATCH = (process.env.ASSET_WAIT_STAGE_MATCH || "waiting for assets").toLowerCase();
const ASSET_CHASE_HOURS = 48;

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

// ─── OPENAI HELPER ──────────────────────────────────────────────────
async function askAI(systemPrompt, userMessage) {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini", max_tokens: 300,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) { console.error("[CMMS] OpenAI error:", res.status); return null; }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) { console.error("[CMMS] OpenAI failed:", e.message); return null; }
}

// ─── CHECK FOR NEW INBOUND MESSAGES ─────────────────────────────────
async function checkInboundMessages() {
  try {
    const data = await ghlFetch(`conversations/search?locationId=${GHL_LOCATION_ID}&limit=20`);
    const convos = data.conversations || [];

    const unread = convos.filter(c => c.unreadCount > 0);
    return unread.map(c => ({
      conversationId: c.id,
      contactId: c.contactId,
      contactName: c.contactName || c.fullName || "Unknown",
      unreadCount: c.unreadCount,
      lastMessageBody: c.lastMessageBody || "",
      lastMessageDate: c.lastMessageDate,
      type: c.type,
    }));
  } catch (e) {
    console.error("[CMMS] Inbound check failed:", e.message);
    return [];
  }
}

// ─── DRAFT A REPLY ──────────────────────────────────────────────────
async function draftReply(contactName, message, conversationType) {
  const prompt = `You are the client communications agent for Echo Growth, a UK marketing agency that builds GoHighLevel systems. Draft a professional, friendly, concise reply to this client message.

Rules:
- Keep it under 100 words
- Use British English
- Be helpful and proactive
- If it's a simple question (login, timeline, next steps), answer directly
- If it's a complaint or escalation topic (billing, refund, cancellation, frustration), reply with empathy and say Sam will follow up personally
- If it's asking for technical help, say you'll flag it to the ops team
- Don't make promises about specific dates unless certain
- Sign off as "Echo Growth Team"

Client name: ${contactName}
Message type: ${conversationType}`;

  return await askAI(prompt, message);
}

// ─── DETECT URGENCY/ESCALATION ──────────────────────────────────────
function needsEscalation(message) {
  const lower = (message || "").toLowerCase();
  const triggers = [
    "refund", "cancel", "billing", "payment", "invoice", "contract",
    "angry", "furious", "disappointed", "terrible", "worst", "scam",
    "urgent", "asap", "emergency", "not working", "broken",
    "speak to someone", "manager", "owner",
  ];
  return triggers.some(t => lower.includes(t));
}

// ─── CATEGORISE MESSAGE ─────────────────────────────────────────────
function categoriseMessage(message) {
  const lower = (message || "").toLowerCase();
  if (lower.includes("login") || lower.includes("password") || lower.includes("access")) return "access";
  if (lower.includes("when") || lower.includes("ready") || lower.includes("timeline")) return "timeline";
  if (lower.includes("not working") || lower.includes("broken") || lower.includes("error") || lower.includes("bug")) return "technical";
  if (lower.includes("cancel") || lower.includes("refund") || lower.includes("billing")) return "escalation";
  if (lower.includes("thank") || lower.includes("great") || lower.includes("awesome")) return "positive";
  if (lower.includes("?")) return "question";
  return "general";
}

// ─── DISCORD REPORT ─────────────────────────────────────────────────
async function sendCmmsReport(report) {
  if (!DISCORD_WEBHOOK) return;

  const embed = {
    title: `💬 CMMS Agent — Inbox Scan`,
    color: report.escalations > 0 ? 0xEF4444 : report.unreadCount > 0 ? 0xFBBF24 : 0x34D399,
    fields: [
      { name: "📬 Unread Conversations", value: `**${report.unreadCount}** need attention`, inline: true },
      { name: "✉️ Drafts Generated", value: `**${report.draftsGenerated}**`, inline: true },
      { name: "🚨 Escalations", value: `**${report.escalations}**`, inline: true },
    ],
    footer: { text: "ECHO GROWTH · AGENT HQ — CMMS Agent" },
    timestamp: new Date().toISOString(),
  };

  if (report.details.length > 0) {
    const detailText = report.details.slice(0, 10).map(d => {
      const icon = d.category === "escalation" ? "🚨" : d.category === "technical" ? "🔧" : d.category === "positive" ? "😊" : "💬";
      return `${icon} **${d.name}**: ${d.preview}`;
    }).join("\n");
    embed.fields.push({ name: "📋 Inbox Details", value: detailText.substring(0, 1024), inline: false });
  }

  if (report.escalations > 0) {
    const escText = report.details
      .filter(d => d.category === "escalation")
      .map(d => `🚨 **${d.name}**: "${d.preview}" — needs Sam's attention`)
      .join("\n");
    if (escText) embed.fields.push({ name: "⚠️ Escalations for Sam", value: escText.substring(0, 1024), inline: false });
  }

  if (report.drafts.length > 0) {
    const draftText = report.drafts.slice(0, 5).map(d =>
      `**To ${d.name}:**\n${d.draft.substring(0, 150)}${d.draft.length > 150 ? "..." : ""}`
    ).join("\n\n");
    embed.fields.push({ name: "📝 Draft Replies (for review)", value: draftText.substring(0, 1024), inline: false });
  }

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "CMMS Agent", embeds: [embed] }),
    });
    console.log("[CMMS] Discord report sent ✓");
  } catch (e) { console.error("[CMMS] Discord failed:", e.message); }
}

// ─── SEND SMS ───────────────────────────────────────────────────────
async function sendSMS(contactId, message) {
  try {
    await ghlFetch(`conversations/messages`, {
      method: "POST",
      body: { type: "SMS", contactId, message },
    });
    return true;
  } catch (e) {
    console.error(`[CMMS] SMS failed ${contactId}:`, e.message);
    return false;
  }
}

// ─── MILESTONE + ASSET CHASE RUN ────────────────────────────────────
async function runMilestoneSweep() {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) return;
  console.log(`[CMMS] Milestone sweep at ${new Date().toLocaleTimeString()}`);

  let milestonesSent = 0;
  let chasesSent = 0;

  try {
    const data = await ghlFetch(`opportunities/search?location_id=${GHL_LOCATION_ID}`, {
      method: "POST", body: { locationId: GHL_LOCATION_ID, status: "won", limit: 100 },
    });
    const opps = data.opportunities || [];

    for (const opp of opps) {
      const stageName = (opp.pipelineStageName || "").toLowerCase();
      const contactId = opp.contact?.id;
      const prevStage = seenStages.get(opp.id);
      seenStages.set(opp.id, stageName);

      if (!contactId) continue;

      // ─── Milestone messages on stage transition ─────────────────
      if (prevStage !== stageName) {
        for (const m of MILESTONES) {
          if (m.match.some(s => stageName.includes(s))) {
            const key = `${opp.id}:${m.key}`;
            if (sentMilestones.has(key)) continue;
            const sent = await sendSMS(contactId, m.sms);
            if (sent) {
              sentMilestones.add(key);
              milestonesSent++;
              await logActivity("CMMS", `milestone ${m.key}`, `SMS to ${opp.contact?.name || contactId}`);
            }
            break; // one milestone per transition
          }
        }
      }

      // ─── Asset chase: waiting stage 48+ hours ──────────────────
      if (stageName.includes(ASSET_WAIT_MATCH)) {
        const lastUpdate = new Date(opp.updatedAt || opp.createdAt).getTime();
        const hoursSince = (Date.now() - lastUpdate) / (60 * 60 * 1000);
        const lastChase = lastChaseAt.get(contactId) || 0;
        const hoursSinceChase = (Date.now() - lastChase) / (60 * 60 * 1000);

        if (hoursSince >= ASSET_CHASE_HOURS && hoursSinceChase >= 24) {
          const name = (opp.contact?.name || "there").split(" ")[0];
          const chase = `Hi ${name}, just a quick nudge — we're ready to keep pushing your build forward but we're waiting on a couple of assets from your side. Could you drop them over when you get a sec? Any questions, ping us in Discord. — Echo Growth Team`;
          const sent = await sendSMS(contactId, chase);
          if (sent) {
            lastChaseAt.set(contactId, Date.now());
            chasesSent++;
            await logActivity("CMMS", "asset chase", `to ${opp.contact?.name || contactId} (${Math.floor(hoursSince)}h waiting)`);
          }
        }
      }
    }

    if (milestonesSent > 0 || chasesSent > 0) {
      console.log(`[CMMS] ✓ Sweep — ${milestonesSent} milestones, ${chasesSent} chases`);
    }
  } catch (e) {
    console.error("[CMMS] Milestone sweep error:", e.message);
  }
}

// ─── MAIN CMMS RUN ──────────────────────────────────────────────────
async function runCmmsAgent() {
  console.log(`[CMMS] Running inbox scan at ${new Date().toLocaleTimeString()}`);
  if (!GHL_API_KEY || !GHL_LOCATION_ID) { console.error("[CMMS] Missing env vars"); return; }

  const unreadConvos = await checkInboundMessages();
  console.log(`[CMMS] Found ${unreadConvos.length} unread conversations`);

  const details = [];
  const drafts = [];
  let escalations = 0;
  let draftsGenerated = 0;

  for (const convo of unreadConvos.slice(0, 15)) {
    const category = categoriseMessage(convo.lastMessageBody);
    const isEscalation = needsEscalation(convo.lastMessageBody);
    if (isEscalation) escalations++;

    const preview = (convo.lastMessageBody || "").substring(0, 80) + ((convo.lastMessageBody || "").length > 80 ? "..." : "");

    details.push({
      name: convo.contactName,
      preview,
      category,
      unreadCount: convo.unreadCount,
      conversationId: convo.conversationId,
    });

    // Draft a reply for non-positive messages
    if (category !== "positive" && OPENAI_API_KEY) {
      const draft = await draftReply(convo.contactName, convo.lastMessageBody, category);
      if (draft) {
        draftsGenerated++;
        drafts.push({
          name: convo.contactName,
          contactId: convo.contactId,
          conversationId: convo.conversationId,
          draft,
          category,
          autoSend: false, // For now, drafts are review-only. Set to true for auto-send on simple queries.
        });
      }
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    unreadCount: unreadConvos.length,
    draftsGenerated,
    escalations,
    details,
    drafts,
  };

  cmmsLog = [report, ...cmmsLog].slice(0, 50);

  // Only send Discord report if there are unread messages
  if (unreadConvos.length > 0) {
    await sendCmmsReport(report);
  }

  if (unreadConvos.length > 0 || escalations > 0) {
    await logActivity("CMMS", "inbox scan", `${unreadConvos.length} unread · ${draftsGenerated} drafts · ${escalations} escalations`);
  }
  console.log(`[CMMS] ✓ Complete — ${unreadConvos.length} unread, ${draftsGenerated} drafts, ${escalations} escalations`);
  return report;
}

// ─── CRON ───────────────────────────────────────────────────────────
// Check every 15 minutes during business hours
cron.schedule("*/15 7-19 * * 1-5", () => runCmmsAgent());

// Milestone + asset chase sweep every 30 minutes during business hours
cron.schedule("*/30 8-18 * * 1-5", () => runMilestoneSweep());

// Also check at 8am and 6pm for start/end of day
cron.schedule("0 7 * * 1-5", () => {
  console.log("[CMMS] Morning inbox check...");
  runCmmsAgent();
});
cron.schedule("0 17 * * 1-5", () => {
  console.log("[CMMS] End of day inbox check...");
  runCmmsAgent();
});

console.log("[CMMS Agent] Started — 15-min inbox scans Mon-Fri 8am-8pm");

export { runCmmsAgent, cmmsLog };
