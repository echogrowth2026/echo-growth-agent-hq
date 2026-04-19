import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cron from "node-cron";
import path from "path";
import http from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();
process.env.IS_DASH = "1";

import { pushActivity, getActivity } from "./activity-log.js";
import {
  generateCopy, approveCopy, rejectCopy,
  listPending as listPendingCopy, listApproved as listApprovedCopy,
} from "./copy-agent.js";
import {
  generateCreative, approveCreative, rejectCreative,
  listPendingCreative, listApprovedCreative,
} from "./crtv-agent.js";
import { analyseStrategy } from "./strt-agent.js";
import { runFunnelScan } from "./funl-agent.js";
import {
  runAdlibScan, getLatestSnapshot as getAdlibSnapshot,
  getLatestPerformance as getAdPerformance, getTopCampaigns as getTopAdCampaigns,
  probeWindsor,
} from "./adlib-agent.js";
import {
  analyseNiche as adspyAnalyse, runDailyScan as adspyDailyScan,
  getLatestForNiche as adspyLatestForNiche, getLatestAll as adspyLatestAll,
} from "./adspy-agent.js";
import { generateAds } from "./adgen-agent.js";
import {
  list as listLibrary, getCreative,
  approveCreative as approveLibraryCreative, rejectCreative as rejectLibraryCreative,
  stats as libraryStats,
} from "./ad-library.js";
import {
  addToReview, listPending as listReviewPendingQueue, listHistory as listReviewHistory,
  approveItem as approveReviewItem, rejectItem as rejectReviewItem,
  stats as reviewStats, getItem as getReviewItem,
} from "./review-queue.js";
import { runJarvisCommand, getConversation } from "./jarvis.js";
import { registerVoiceRoutes, jarvisSpeakResolver } from "./voice-api.js";
import { generateN8nWorkflow, listN8nWorkflows, getN8nWorkflow } from "./n8n-agent.js";
import {
  generateLinkedinPost, listLinkedinQueue, getLinkedinPost,
  prepareLinkedinDesktopPost, confirmLinkedinDesktopPost, cancelLinkedinDesktopPost,
} from "./linkedin-agent.js";
import { generateGhlWorkflow, listGhlWorkflows, getGhlWorkflow, runAutoAgent } from "./auto-agent.js";
import { browserStatus } from "./browser.js";

const app = express();
app.use(cors());
app.use(express.json());
// Serve generated creative images to the frontend
app.use("/library-images", express.static(path.join(__dirname, "data", "ad-library")));

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const PORT = process.env.PORT || 3001;

// ─── CACHE ──────────────────────────────────────────────────────────
let dashCache = { lastUpdated: null, data: null };
let briefingHistory = [];

// Discord channel counters, populated by CSM posting increments.
// Keyed by ISO date (YYYY-MM-DD) so daily rollover is free.
const discordStats = {
  daily: {},   // { "2026-04-18": { leads: 3, calls: 1, payments: 0, paymentsAmount: 0 } }
  monthly: {}, // { "2026-04": { payments: 12, paymentsAmount: 72000 } }
};

function todayKey() { return new Date().toISOString().slice(0, 10); }
function monthKey() { return new Date().toISOString().slice(0, 7); }

function incrementDiscordStat(type, amount = 1) {
  const d = todayKey(), m = monthKey();
  if (!discordStats.daily[d]) discordStats.daily[d] = { leads: 0, calls: 0, payments: 0, paymentsAmount: 0 };
  if (!discordStats.monthly[m]) discordStats.monthly[m] = { payments: 0, paymentsAmount: 0 };

  if (type === "leads") discordStats.daily[d].leads += 1;
  else if (type === "calls") discordStats.daily[d].calls += 1;
  else if (type === "payments") {
    discordStats.daily[d].payments += 1;
    discordStats.daily[d].paymentsAmount += amount;
    discordStats.monthly[m].payments += 1;
    discordStats.monthly[m].paymentsAmount += amount;
  }
}

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
    pushActivity({
      agent: "DASH",
      action: briefingType === "refresh" ? "refresh" : `${briefingType} briefing`,
      details: `${leads.today} new leads · ${bookings.showRate}% show · ${opportunities.open} open opps`,
    });
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

// ─── DISCORD CHANNEL COUNTERS ───────────────────────────────────────
app.get("/api/dash/discord-stats", (req, res) => {
  const today = discordStats.daily[todayKey()] || { leads: 0, calls: 0, payments: 0, paymentsAmount: 0 };
  const month = discordStats.monthly[monthKey()] || { payments: 0, paymentsAmount: 0 };
  res.json({
    today: {
      date: todayKey(),
      leads: today.leads,
      calls: today.calls,
      payments: today.payments,
      paymentsAmount: today.paymentsAmount,
    },
    month: { period: monthKey(), ...month },
    history: discordStats.daily,
  });
});

app.post("/api/dash/discord-stats/increment", (req, res) => {
  const { type, amount } = req.body || {};
  if (!["leads", "calls", "payments"].includes(type)) return res.status(400).json({ error: "bad type" });
  incrementDiscordStat(type, Number(amount) || 0);
  res.json({ ok: true, today: discordStats.daily[todayKey()] });
});

// ─── SHARED ACTIVITY LOG ────────────────────────────────────────────
app.get("/api/agents/activity", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  res.json({ activity: getActivity(limit), count: getActivity(limit).length });
});

app.post("/api/agents/activity/log", (req, res) => {
  const entry = pushActivity(req.body || {});
  res.json({ ok: true, entry });
});

// ─── COPY ENDPOINTS ─────────────────────────────────────────────────
app.post("/api/copy/generate", async (req, res) => {
  const entry = await generateCopy(req.body || {});
  res.json(entry || { error: "generation failed" });
});
app.get("/api/copy/pending", (req, res) => res.json({ pending: listPendingCopy() }));
app.get("/api/copy/approved", (req, res) => res.json({ approved: listApprovedCopy() }));
app.post("/api/copy/approve", (req, res) => {
  const entry = approveCopy(req.body?.id, req.body?.feedback);
  res.json(entry ? { ok: true, entry } : { ok: false, error: "not found" });
});
app.post("/api/copy/reject", (req, res) => {
  const entry = rejectCopy(req.body?.id, req.body?.feedback);
  res.json(entry ? { ok: true, entry } : { ok: false, error: "not found" });
});

// ─── CRTV ENDPOINTS ─────────────────────────────────────────────────
app.post("/api/crtv/generate", async (req, res) => {
  const entry = await generateCreative(req.body || {});
  res.json(entry || { error: "generation failed" });
});
app.get("/api/crtv/pending", (req, res) => res.json({ pending: listPendingCreative() }));
app.get("/api/crtv/approved", (req, res) => res.json({ approved: listApprovedCreative() }));
app.post("/api/crtv/approve", (req, res) => {
  const entry = approveCreative(req.body?.id, req.body?.feedback);
  res.json(entry ? { ok: true, entry } : { ok: false, error: "not found" });
});
app.post("/api/crtv/reject", (req, res) => {
  const entry = rejectCreative(req.body?.id, req.body?.feedback);
  res.json(entry ? { ok: true, entry } : { ok: false, error: "not found" });
});

// ─── STRT / FUNL / ADLIB ENDPOINTS ──────────────────────────────────
app.post("/api/strt/analyse", async (req, res) => {
  const entry = await analyseStrategy(req.body?.question || null);
  res.json(entry || { error: "analysis failed" });
});
app.post("/api/funl/scan", async (req, res) => {
  const report = await runFunnelScan();
  res.json(report || { error: "scan failed" });
});
app.post("/api/adlib/scan", async (req, res) => {
  const report = await runAdlibScan();
  res.json(report || { error: "scan failed" });
});

// Diagnostic probe for Windsor.ai connection issues.
// Hit GET /api/adlib/probe from Railway's shell or a browser to see
// which date_preset / field combination is accepted by your account.
app.get("/api/adlib/probe", async (req, res) => res.json(await probeWindsor()));

// ─── AD STATS (Windsor.ai, read-only proxy) ─────────────────────────
// Serves the most recent cached ADLIB snapshot. If there's nothing
// cached yet (first boot of the day), triggers a scan inline.
app.get("/api/dash/ad-stats", async (req, res) => {
  let snap = getAdlibSnapshot();
  if (!snap) {
    const result = await runAdlibScan();
    snap = getAdlibSnapshot();
    if (!snap && result) snap = { performance: result.performance, fatigued: result.fatigued?.length || 0, timestamp: new Date().toISOString() };
  }
  res.json({
    lastUpdated: snap?.timestamp || null,
    performance: getAdPerformance() || snap?.performance || null,
    topByCtr: getTopAdCampaigns("ctr", 5),
    topBySpend: getTopAdCampaigns("spend", 5),
    fatigued: snap?.fatigued || 0,
    source: "windsor.ai (read-only)",
  });
});

// ─── ECHO AD LIBRARY ────────────────────────────────────────────────
app.get("/api/library", (req, res) => {
  const { status, niche, from, to, limit } = req.query;
  res.json({ items: listLibrary({ status, niche, from, to, limit: Number(limit) || undefined }) });
});
app.get("/api/library/stats", (req, res) => res.json(libraryStats()));
app.get("/api/library/:id", (req, res) => {
  const item = getCreative(req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  res.json(item);
});
app.put("/api/library/:id/approve", (req, res) => {
  const entry = approveLibraryCreative(req.params.id, req.body?.feedback);
  res.json(entry ? { ok: true, entry } : { ok: false, error: "not found" });
});
app.put("/api/library/:id/reject", (req, res) => {
  const entry = rejectLibraryCreative(req.params.id, req.body?.feedback);
  res.json(entry ? { ok: true, entry } : { ok: false, error: "not found" });
});

// ─── UNIFIED REVIEW QUEUE ──────────────────────────────────────────
// Aggregates review-queue.json + pending from COPY + pending from CRTV.
// Routing for approve/reject is by id prefix so the frontend just sends
// the id and doesn't have to care which store owns it.
function aggregatePending() {
  const queue = listReviewPendingQueue().map(i => ({ ...i, source: "queue" }));
  const copy = listPendingCopy().map(i => ({
    id: i.id, agent: "COPY", type: "copy",
    content: i.output, meta: i.input,
    status: "pending", createdAt: i.timestamp, source: "copy",
  }));
  const crtv = listPendingCreative().map(i => ({
    id: i.id, agent: "CRTV", type: "brief",
    content: i.output, meta: i.input,
    status: "pending", createdAt: i.timestamp, source: "crtv",
  }));
  return [...queue, ...copy, ...crtv].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function decideReview(id, action, feedback) {
  // COPY pending
  if (id.startsWith("copy_")) {
    const entry = action === "approve" ? approveCopy(id, feedback) : rejectCopy(id, feedback);
    // When copy is approved, fire ADGEN to produce visuals for it.
    if (entry && action === "approve") {
      const niche = entry.input?.niche;
      const headline = entry.output?.headlines?.[0];
      generateAds({
        niche,
        offer: entry.input?.offer,
        audience: entry.input?.audience,
        copyText: headline,
        creativeDirection: entry.output?.angle_rewrites?.[0]?.angle,
      }).catch(e => console.error("[DASH] ADGEN trigger failed:", e.message));
    }
    return entry ? { ok: true, entry, triggered: action === "approve" ? "ADGEN" : null } : null;
  }
  // CRTV pending
  if (id.startsWith("crtv_")) {
    const entry = action === "approve" ? approveCreative(id, feedback) : rejectCreative(id, feedback);
    return entry ? { ok: true, entry } : null;
  }
  // Queue item — may reference an ad-library creative
  if (id.startsWith("rq_")) {
    const item = getReviewItem(id);
    const entry = action === "approve" ? approveReviewItem(id, feedback) : rejectReviewItem(id, feedback);
    if (item?.content?.creativeId) {
      action === "approve"
        ? approveLibraryCreative(item.content.creativeId, feedback)
        : rejectLibraryCreative(item.content.creativeId, feedback);
    }
    // LinkedIn approvals trigger the desktop paste flow if the
    // companion is connected. Otherwise Sam copies from Discord.
    let triggered = null;
    if (entry && action === "approve" && item?.type === "linkedin" && item?.content?.postId) {
      if (desktopClient && desktopClient.readyState === 1) {
        prepareLinkedinDesktopPost({ postId: item.content.postId, sendToDesktop })
          .catch(e => console.error("[DASH] LinkedIn desktop paste failed:", e.message));
        triggered = "DESKTOP_PASTE";
      }
    }
    return entry ? { ok: true, entry, triggered } : null;
  }
  // Direct ad-library id
  if (id.startsWith("creative_")) {
    const entry = action === "approve" ? approveLibraryCreative(id, feedback) : rejectLibraryCreative(id, feedback);
    return entry ? { ok: true, entry } : null;
  }
  return null;
}

app.get("/api/review", (req, res) => res.json({ pending: aggregatePending() }));
app.get("/api/review/history", (req, res) => res.json({ history: listReviewHistory(Number(req.query.limit) || 100) }));
app.get("/api/review/stats", (req, res) => res.json(reviewStats()));
app.put("/api/review/:id/approve", async (req, res) => {
  const result = await decideReview(req.params.id, "approve", req.body?.feedback);
  res.json(result || { ok: false, error: "not found" });
});
app.put("/api/review/:id/reject", async (req, res) => {
  const result = await decideReview(req.params.id, "reject", req.body?.feedback);
  res.json(result || { ok: false, error: "not found" });
});
// Any agent can enqueue a review item directly.
app.post("/api/review/add", (req, res) => {
  const { agent, type, content, meta } = req.body || {};
  if (!agent || !type || !content) return res.status(400).json({ error: "agent, type, content required" });
  res.json({ ok: true, item: addToReview(agent, type, content, meta || {}) });
});

// ─── ADSPY ENDPOINTS ────────────────────────────────────────────────
app.get("/api/adspy/latest", (req, res) => res.json({ niches: adspyLatestAll() }));
app.get("/api/adspy/niche/:niche", (req, res) => {
  const entry = adspyLatestForNiche(req.params.niche);
  res.json(entry || { error: "no data for niche" });
});
app.post("/api/adspy/analyse", async (req, res) => {
  const niche = req.body?.niche || "B2B service businesses";
  const entry = await adspyAnalyse(niche);
  res.json(entry || { error: "analysis failed" });
});
app.post("/api/adspy/scan", async (req, res) => {
  const reports = await adspyDailyScan();
  res.json({ count: reports.length, reports });
});

// ─── ADGEN ENDPOINTS ────────────────────────────────────────────────
app.post("/api/adgen/generate", async (req, res) => {
  const result = await generateAds(req.body || {});
  res.json(result || { error: "generation failed" });
});
app.get("/api/adgen/library", (req, res) => res.json({ items: listLibrary({ status: req.query.status }) }));
app.get("/api/health", (req, res) => res.json({
  status: "ok", agent: "DASH", lastUpdated: dashCache.lastUpdated,
  locationId: GHL_LOCATION_ID ? "✓" : "✗", apiKey: GHL_API_KEY ? "✓" : "✗",
  discordWebhook: DISCORD_WEBHOOK ? "✓" : "✗", briefings: briefingHistory.length,
}));

// ─── JARVIS COMMAND ENDPOINT ────────────────────────────────────────
// Text in / text + optional audio-playable instructions out. Agent
// handlers are wired in-process for low-latency calls.
app.post("/api/jarvis/command", async (req, res) => {
  const text = (req.body?.text || "").trim();
  const voice = !!req.body?.voice;
  if (!text) return res.status(400).json({ ok: false, error: "empty command" });

  const ctx = {
    lookupClient, getPipelines, runDashAgent, dashCache,
    generateCopy, generateCreative, analyseStrategy,
    adspyLatestForNiche, adspyAnalyse,
    runAdlibScan, runFunnelScan, generateAds,
    listReviewPending: listReviewPendingQueue,
    getActivity,
    generateN8nWorkflow, generateGhlWorkflow, generateLinkedinPost,
    sendToDesktop,
    desktopStatus: () => ({
      connected: !!(desktopClient && desktopClient.readyState === 1),
      authenticated: desktopAuthenticated,
      lastSeen: desktopLastSeen,
    }),
    // Jarvis POST_LINKEDIN path: runs the linkedin_post template and
    // publishes immediately. The Review-queue approve flow still goes
    // through /api/linkedin/:id/prepare-post → confirm-post (two-step
    // manual) because that's initiated by a human approval action.
    postLinkedinPost: async ({ postId, content, text }) => {
      const finalText = text || content || (postId ? getLinkedinPost(postId)?.content?.full_text : null);
      if (!finalText) return { ok: false, error: "no content to post" };
      const result = await sendToDesktop({
        type: "execute_template",
        name: "linkedin_post",
        params: { text: finalText },
      }, { timeoutMs: 60_000 });
      return {
        ok: !!result?.success,
        stage: result?.success ? "published" : "failed",
        result,
        error: result?.error || null,
        postId: postId || null,
      };
    },
    importN8nWorkflow: async (workflowId) => {
      const entry = getN8nWorkflow(workflowId);
      if (!entry) return { ok: false, error: "workflow not found" };
      const imported = await sendToDesktop({
        type: "BROWSER_ACTION",
        action: { service: "n8n", type: "import-workflow", workflow: entry.workflow, name: entry.name },
      }, { timeoutMs: 180_000 });
      return { ok: true, imported };
    },
  };

  const result = await runJarvisCommand({
    text,
    ctx,
    voice,
    speakFn: voice ? (t) => jarvisSpeakResolver(t) : null,
  });
  res.json(result);
});

app.get("/api/jarvis/history", (req, res) => {
  res.json({ history: getConversation(Number(req.query.limit) || 50) });
});

// ─── VOICE ROUTES ───────────────────────────────────────────────────
registerVoiceRoutes(app);

// ─── N8N AUTOMATION ROUTES ──────────────────────────────────────────
app.post("/api/n8n/generate", async (req, res) => {
  const entry = await generateN8nWorkflow(req.body || {});
  res.json(entry || { error: "generation failed" });
});
app.get("/api/n8n/list", (req, res) => res.json({ workflows: listN8nWorkflows() }));
app.get("/api/n8n/download/:id", (req, res) => {
  const entry = getN8nWorkflow(req.params.id);
  if (!entry) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${entry.id}.json"`);
  res.send(JSON.stringify(entry.workflow || {}, null, 2));
});

// ─── LINKEDIN ROUTES ────────────────────────────────────────────────
app.post("/api/linkedin/generate", async (req, res) => {
  const entry = await generateLinkedinPost(req.body || {});
  res.json(entry || { error: "generation failed" });
});
app.get("/api/linkedin/queue", (req, res) => res.json({ queue: listLinkedinQueue(Number(req.query.limit) || 50) }));
app.get("/api/linkedin/:id", (req, res) => {
  const entry = getLinkedinPost(req.params.id);
  if (!entry) return res.status(404).json({ error: "not found" });
  res.json(entry);
});

// Two-step desktop post flow — paste, confirm, cancel.
app.post("/api/linkedin/:id/prepare-post", async (req, res) => {
  const result = await prepareLinkedinDesktopPost({ postId: req.params.id, sendToDesktop });
  res.json(result);
});
app.post("/api/linkedin/:id/confirm-post", async (req, res) => {
  const result = await confirmLinkedinDesktopPost({ postId: req.params.id, sendToDesktop });
  res.json(result);
});
app.post("/api/linkedin/:id/cancel-post", async (req, res) => {
  const result = await cancelLinkedinDesktopPost({ postId: req.params.id, sendToDesktop });
  res.json(result);
});

// ─── GHL WORKFLOW GEN (via AUTO) ────────────────────────────────────
app.post("/api/auto/generate-workflow", async (req, res) => {
  const entry = await generateGhlWorkflow(req.body || {});
  res.json(entry || { error: "generation failed" });
});
app.get("/api/auto/workflows", (req, res) => res.json({ workflows: listGhlWorkflows() }));
app.get("/api/auto/workflows/:id", (req, res) => {
  const entry = getGhlWorkflow(req.params.id);
  if (!entry) return res.status(404).json({ error: "not found" });
  res.json(entry);
});

// Browser status — still surfaced here because the desktop companion
// reports its own Puppeteer state via /api/desktop/status and some
// legacy callers check this path.
app.get("/api/computer/status", (req, res) => res.json({ browser: browserStatus() }));

// ─── DESKTOP AGENT (WebSocket RPC) ──────────────────────────────────
// Single-client model: only one desktop agent can be connected at a
// time. Commands sent from server → desktop are correlated by id and
// returned to the caller via a pending-promise map. Optional auth
// token gate via DESKTOP_AUTH_TOKEN — if unset, any client may
// connect (fine for Sam's private deploy).
const DESKTOP_AUTH_TOKEN = process.env.DESKTOP_AUTH_TOKEN || null;
let desktopClient = null;
let desktopAuthenticated = false;
let desktopLastSeen = null;
const desktopPending = new Map();

function sendToDesktop(command, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!desktopClient || desktopClient.readyState !== 1) {
      reject(new Error("Desktop agent not connected"));
      return;
    }
    if (DESKTOP_AUTH_TOKEN && !desktopAuthenticated) {
      reject(new Error("Desktop agent not authenticated"));
      return;
    }
    const id = `dcmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timer = setTimeout(() => {
      desktopPending.delete(id);
      reject(new Error("Desktop command timeout"));
    }, timeoutMs);
    desktopPending.set(id, { resolve, reject, timer });
    desktopClient.send(JSON.stringify({ ...command, id }));
  });
}

app.get("/api/desktop/status", (req, res) => res.json({
  connected: !!(desktopClient && desktopClient.readyState === 1),
  authenticated: desktopAuthenticated,
  lastSeen: desktopLastSeen,
  authRequired: !!DESKTOP_AUTH_TOKEN,
}));

app.post("/api/desktop/command", async (req, res) => {
  try {
    const result = await sendToDesktop(req.body || {});
    res.json({ ok: true, result });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/desktop" });

wss.on("connection", (ws, req) => {
  console.log(`[DASH] Desktop agent connecting from ${req.socket.remoteAddress}`);
  // Single-client lock — close any previous connection first.
  if (desktopClient && desktopClient !== ws) {
    try { desktopClient.close(1000, "replaced by new client"); } catch {}
  }
  desktopClient = ws;
  desktopAuthenticated = !DESKTOP_AUTH_TOKEN;
  desktopLastSeen = new Date().toISOString();

  ws.on("message", (raw) => {
    desktopLastSeen = new Date().toISOString();
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (msg.type === "auth") {
      if (!DESKTOP_AUTH_TOKEN || msg.token === DESKTOP_AUTH_TOKEN) {
        desktopAuthenticated = true;
        ws.send(JSON.stringify({ type: "auth-ok" }));
        console.log("[DASH] Desktop agent authenticated ✓");
      } else {
        ws.send(JSON.stringify({ type: "auth-fail" }));
        try { ws.close(1008, "auth failed"); } catch {}
      }
      return;
    }

    if (msg.type === "result" && msg.id && desktopPending.has(msg.id)) {
      const pending = desktopPending.get(msg.id);
      clearTimeout(pending.timer);
      desktopPending.delete(msg.id);
      pending.resolve(msg.result);
      return;
    }

    if (msg.type === "event") {
      // Desktop-initiated events (e.g. screenshots, status) — logged
      // to the activity feed for visibility in the Agent Room.
      pushActivity({ agent: "DESKTOP", action: msg.event || "event", details: msg.detail || "" });
      return;
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[DASH] Desktop agent disconnected (${code})`);
    if (desktopClient === ws) {
      desktopClient = null;
      desktopAuthenticated = false;
      // Reject any still-pending commands so callers unblock.
      for (const [id, p] of desktopPending.entries()) {
        clearTimeout(p.timer);
        p.reject(new Error("Desktop agent disconnected"));
        desktopPending.delete(id);
      }
    }
  });

  ws.on("error", (e) => console.error("[DASH] Desktop WS error:", e.message));
});

server.listen(PORT, () => {
  console.log(`[DASH] Port ${PORT} | Location: ${GHL_LOCATION_ID} | Discord: ${DISCORD_WEBHOOK ? "✓" : "✗"}`);
  console.log(`[DASH] Desktop WS mounted at /ws/desktop · auth: ${DESKTOP_AUTH_TOKEN ? "required" : "open"}`);
  runDashAgent("refresh");
});

// Exported for other modules (Jarvis, LinkedIn) that want to push
// commands to the desktop without going through HTTP.
export { sendToDesktop };
