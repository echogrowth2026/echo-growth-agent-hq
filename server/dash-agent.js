import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cron from "node-cron";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const PORT = process.env.PORT || 3001;

// ─── CACHE ──────────────────────────────────────────────────────────
let dashCache = { lastUpdated: null, data: null };
let briefingHistory = [];

// ─── GHL v2 API HELPER ─────────────────────────────────────────────
async function ghlFetch(endpoint, options = {}) {
  const method = options.method || "GET";
  const body = options.body || null;
  const res = await fetch(`https://services.leadconnectorhq.com/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL API error: ${res.status} ${endpoint} — ${text}`);
  }
  return res.json();
}

// ─── PULL CONTACTS (LEADS) ──────────────────────────────────────────
async function getLeads() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const data = await ghlFetch(`contacts/?locationId=${GHL_LOCATION_ID}&limit=100`);
    const contacts = data.contacts || [];
    const todayLeads = contacts.filter((c) => new Date(c.dateAdded) >= today);
    return { total: contacts.length, today: todayLeads.length, raw: contacts.slice(0, 10) };
  } catch (e) {
    console.error("Leads error:", e.message);
    return { total: 0, today: 0, raw: [] };
  }
}

// ─── PULL PIPELINES & STAGES ────────────────────────────────────────
async function getPipelines() {
  try {
    const data = await ghlFetch(`opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    const pipelines = data.pipelines || [];
    return pipelines.map(p => ({
      id: p.id,
      name: p.name,
      stages: (p.stages || []).map(s => ({ id: s.id, name: s.name })),
    }));
  } catch (e) {
    console.error("Pipelines error:", e.message);
    return [];
  }
}

// ─── PULL OPPORTUNITIES WITH STAGE COUNTS ───────────────────────────
async function getOpportunitiesWithStages() {
  try {
    const pipelines = await getPipelines();
    const allPipelineData = [];

    for (const pipeline of pipelines) {
      const data = await ghlFetch(
        `opportunities/search?location_id=${GHL_LOCATION_ID}`,
        { method: "POST", body: { locationId: GHL_LOCATION_ID, limit: 100 } }
      );

      const opps = data.opportunities || [];
      const stageCounts = {};
      for (const stage of pipeline.stages) {
        stageCounts[stage.name] = opps.filter(o => o.pipelineStageId === stage.id).length;
      }

      allPipelineData.push({
        id: pipeline.id, name: pipeline.name, total: opps.length,
        won: opps.filter(o => o.status === "won").length,
        lost: opps.filter(o => o.status === "lost").length,
        open: opps.filter(o => o.status === "open").length,
        totalValue: opps.filter(o => o.status === "open").reduce((s, o) => s + (o.monetaryValue || 0), 0),
        stages: stageCounts,
      });
    }

    return {
      total: allPipelineData.reduce((s, p) => s + p.total, 0),
      open: allPipelineData.reduce((s, p) => s + p.open, 0),
      won: allPipelineData.reduce((s, p) => s + p.won, 0),
      lost: allPipelineData.reduce((s, p) => s + p.lost, 0),
      totalValue: allPipelineData.reduce((s, p) => s + p.totalValue, 0),
      pipelines: allPipelineData,
    };
  } catch (e) {
    console.error("Opportunities error:", e.message);
    return { total: 0, open: 0, won: 0, lost: 0, totalValue: 0, pipelines: [] };
  }
}

// ─── PULL BOOKINGS ──────────────────────────────────────────────────
async function getBookings() {
  try {
    const calendars = await ghlFetch(`calendars/?locationId=${GHL_LOCATION_ID}`);
    const calList = calendars.calendars || [];
    if (calList.length === 0) return { total: 0, today: 0, showRate: 0, showed: 0 };
    const calId = calList[0].id;
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    const appts = await ghlFetch(`calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${calId}&startTime=${startOfDay.getTime()}&endTime=${endOfDay.getTime()}`);
    const events = appts.events || [];
    const showed = events.filter(e => e.appointmentStatus === "showed").length;
    return { total: events.length, today: events.length, showRate: events.length > 0 ? Math.round((showed / events.length) * 100) : 0, showed };
  } catch (e) {
    console.error("Bookings error:", e.message);
    return { total: 0, today: 0, showRate: 0, showed: 0 };
  }
}

// ─── PULL CONVERSATIONS ─────────────────────────────────────────────
async function getConversations() {
  try {
    const data = await ghlFetch(`conversations/search?locationId=${GHL_LOCATION_ID}&limit=20`);
    const convos = data.conversations || [];
    return { total: convos.length, unread: convos.filter(c => c.unreadCount > 0).length };
  } catch (e) {
    console.error("Conversations error:", e.message);
    return { total: 0, unread: 0 };
  }
}

// ─── CLIENT LOOKUP ──────────────────────────────────────────────────
async function lookupClient(name) {
  try {
    const data = await ghlFetch(`contacts/search?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(name)}&limit=5`);
    const contacts = data.contacts || [];
    if (contacts.length === 0) return { found: false, message: `No contact found matching "${name}"` };

    const results = [];
    for (const contact of contacts) {
      let oppInfo = [];
      try {
        const oppData = await ghlFetch(`opportunities/search?location_id=${GHL_LOCATION_ID}`, {
          method: "POST", body: { locationId: GHL_LOCATION_ID, contact_id: contact.id, limit: 10 },
        });
        oppInfo = (oppData.opportunities || []).map(o => ({
          pipeline: o.pipelineName || "Unknown", stage: o.pipelineStageName || "Unknown",
          status: o.status, value: o.monetaryValue || 0, lastActivity: o.lastActivity || o.updatedAt,
        }));
      } catch (e) { /* continue */ }

      results.push({
        name: contact.contactName || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
        email: contact.email, phone: contact.phone, tags: contact.tags || [],
        dateAdded: contact.dateAdded, lastActivity: contact.lastActivity || contact.dateUpdated,
        source: contact.source, opportunities: oppInfo,
      });
    }
    return { found: true, count: results.length, contacts: results };
  } catch (e) {
    console.error("Client lookup error:", e.message);
    return { found: false, message: e.message };
  }
}

// ─── DISCORD WEBHOOK ────────────────────────────────────────────────
async function sendDiscordBriefing(summary, type = "refresh") {
  if (!DISCORD_WEBHOOK) return;
  const { leads, opportunities, bookings, conversations, alerts } = summary;
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  const dateStr = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });

  const isMorning = type === "morning";
  const isEOD = type === "eod";
  let title = "📊 DASH — Data Refresh"; let color = 0x34D399;
  if (isMorning) { title = "☀️ DASH — Morning Briefing"; color = 0xFBBF24; }
  else if (isEOD) { title = "🌙 DASH — End of Day Summary"; color = 0x60A5FA; }

  let pipelineBreakdown = "";
  if (opportunities?.pipelines) {
    for (const p of opportunities.pipelines) {
      pipelineBreakdown += `\n**${p.name}** (${p.total})\n`;
      const active = Object.entries(p.stages).filter(([_, c]) => c > 0);
      pipelineBreakdown += active.length > 0 ? active.map(([n, c]) => `› ${n}: **${c}**`).join("\n") : "› Empty";
    }
  }

  const embed = {
    title, description: `**${dateStr}** at **${timeStr}**`, color,
    fields: [
      { name: "📋 Leads", value: `**${leads?.total || 0}** total\n**${leads?.today || 0}** new today`, inline: true },
      { name: "💰 Pipeline", value: `**${opportunities?.total || 0}** total · **${opportunities?.open || 0}** open\n**${opportunities?.won || 0}** won · **${opportunities?.lost || 0}** lost\n£${(opportunities?.totalValue || 0).toLocaleString()}`, inline: true },
      { name: "📅 Bookings", value: `**${bookings?.total || 0}** today · **${bookings?.showRate || 0}%** show rate`, inline: true },
      { name: "💬 Convos", value: `**${conversations?.total || 0}** total · **${conversations?.unread || 0}** unread`, inline: true },
    ],
    footer: { text: "ECHO GROWTH · AGENT HQ — DASH Agent" }, timestamp: new Date().toISOString(),
  };

  if ((isMorning || isEOD) && pipelineBreakdown) {
    embed.fields.push({ name: "📊 Pipeline Stages", value: pipelineBreakdown.substring(0, 1024), inline: false });
  }
  if ((alerts || []).length > 0) {
    embed.fields.push({ name: "🚨 Alerts", value: alerts.map(a => `${a.level === "warning" ? "⚠️" : "ℹ️"} ${a.message}`).join("\n"), inline: false });
  }
  if (isMorning) {
    const actions = [];
    if ((leads?.today || 0) === 0) actions.push("• No new leads — check META");
    if ((bookings?.showRate || 0) < 60 && (bookings?.total || 0) > 0) actions.push("• Show rate low — check follow-ups");
    if ((conversations?.unread || 0) > 5) actions.push(`• ${conversations.unread} unread convos`);
    if (actions.length > 0) embed.fields.push({ name: "🎯 Actions", value: actions.join("\n"), inline: false });
  }
  if (isEOD) {
    embed.fields.push({ name: "📝 Day Wrap", value: `**${leads?.today || 0}** new leads · **${bookings?.showed || 0}/${bookings?.total || 0}** showed · **${opportunities?.won || 0}** won`, inline: false });
  }

  try {
    await fetch(DISCORD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "DASH Agent", embeds: [embed] }) });
    console.log(`[DASH] Discord ${type} sent ✓`);
  } catch (e) { console.error("[DASH] Discord failed:", e.message); }
}

// ─── MAIN DASH PULL ─────────────────────────────────────────────────
async function runDashAgent(briefingType = "refresh") {
  console.log(`[DASH] Running at ${new Date().toLocaleTimeString()}`);
  if (!GHL_API_KEY || !GHL_LOCATION_ID) { console.error("[DASH] Missing env vars"); return null; }

  try {
    const [leads, opportunities, bookings, conversations] = await Promise.all([
      getLeads(), getOpportunitiesWithStages(), getBookings(), getConversations(),
    ]);

    const summary = { lastUpdated: new Date().toISOString(), leads, opportunities, bookings, conversations, alerts: [] };

    if (bookings.showRate < 60 && bookings.total > 0) summary.alerts.push({ level: "warning", message: `Show rate ${bookings.showRate}%`, agent: "DASH" });
    if (conversations.unread > 5) summary.alerts.push({ level: "warning", message: `${conversations.unread} unread convos`, agent: "CMMS" });
    if (leads.today === 0) summary.alerts.push({ level: "info", message: "No new leads today", agent: "META" });

    dashCache = { lastUpdated: new Date(), data: summary };
    console.log(`[DASH] ✓ Refreshed — ${leads.today} leads, ${bookings.showRate}% show, ${opportunities.pipelines?.length || 0} pipelines`);

    if (briefingType === "morning" || briefingType === "eod") {
      briefingHistory = [{ id: Date.now(), type: briefingType, timestamp: new Date().toISOString(), summary }, ...briefingHistory].slice(0, 20);
      await sendDiscordBriefing(summary, briefingType);
    }
    return summary;
  } catch (e) { console.error("[DASH] Error:", e.message); return null; }
}

// ─── CRON ───────────────────────────────────────────────────────────
cron.schedule("0 6 * * *", () => runDashAgent("morning"));
cron.schedule("0 22 * * *", () => runDashAgent("eod"));
cron.schedule("*/15 7-18 * * 1-5", () => runDashAgent("refresh"));

// ─── ROUTES ─────────────────────────────────────────────────────────
app.get("/api/dash", async (req, res) => {
  if (!dashCache.data) { const d = await runDashAgent("refresh"); return res.json(d || { error: "No data" }); }
  res.json(dashCache.data);
});
app.post("/api/dash/refresh", async (req, res) => res.json(await runDashAgent("refresh") || { error: "Failed" }));
app.get("/api/dash/briefings", (req, res) => res.json({ briefings: briefingHistory, count: briefingHistory.length }));
app.post("/api/dash/briefing/send", async (req, res) => {
  const t = req.body?.type || "morning";
  const d = await runDashAgent(t);
  res.json(d ? { success: true, type: t } : { success: false });
});
app.get("/api/dash/lookup/:name", async (req, res) => res.json(await lookupClient(req.params.name)));
app.get("/api/dash/pipelines", async (req, res) => res.json({ pipelines: await getPipelines() }));
app.get("/api/health", (req, res) => res.json({
  status: "ok", agent: "DASH", lastUpdated: dashCache.lastUpdated,
  locationId: GHL_LOCATION_ID ? "✓" : "✗", apiKey: GHL_API_KEY ? "✓" : "✗",
  discordWebhook: DISCORD_WEBHOOK ? "✓" : "✗", briefings: briefingHistory.length,
}));

app.listen(PORT, () => {
  console.log(`[DASH] Port ${PORT} | Location: ${GHL_LOCATION_ID} | Discord: ${DISCORD_WEBHOOK ? "✓" : "✗"}`);
  runDashAgent("refresh");
});
