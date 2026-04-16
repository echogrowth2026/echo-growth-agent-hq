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
let dashCache = {
  lastUpdated: null,
  data: null,
};

// Briefing history (keeps last 20 briefings in memory)
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

    return {
      total: contacts.length,
      today: todayLeads.length,
      raw: contacts.slice(0, 10),
    };
  } catch (e) {
    console.error("Leads error:", e.message);
    return { total: 0, today: 0, raw: [] };
  }
}

// ─── PULL OPPORTUNITIES (PIPELINE) ──────────────────────────────────
async function getOpportunities() {
  try {
    const data = await ghlFetch(
      `opportunities/search?location_id=${GHL_LOCATION_ID}`,
      {
        method: "POST",
        body: {
          locationId: GHL_LOCATION_ID,
          limit: 100,
        },
      }
    );

    const opps = data.opportunities || [];
    const won = opps.filter((o) => o.status === "won").length;
    const lost = opps.filter((o) => o.status === "lost").length;
    const open = opps.filter((o) => o.status === "open").length;
    const totalValue = opps
      .filter((o) => o.status === "open")
      .reduce((sum, o) => sum + (o.monetaryValue || 0), 0);

    return { total: opps.length, won, lost, open, totalValue };
  } catch (e) {
    console.error("Opportunities error:", e.message);
    return { total: 0, won: 0, lost: 0, open: 0, totalValue: 0 };
  }
}

// ─── PULL CALENDARS / BOOKINGS ──────────────────────────────────────
async function getBookings() {
  try {
    const calendars = await ghlFetch(`calendars/?locationId=${GHL_LOCATION_ID}`);
    const calList = calendars.calendars || [];

    if (calList.length === 0) return { total: 0, today: 0, showRate: 0, showed: 0 };

    const calId = calList[0].id;
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const appts = await ghlFetch(
      `calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${calId}&startTime=${startOfDay.getTime()}&endTime=${endOfDay.getTime()}`
    );

    const events = appts.events || [];
    const showed = events.filter((e) => e.appointmentStatus === "showed").length;
    const total = events.length;
    const showRate = total > 0 ? Math.round((showed / total) * 100) : 0;

    return { total, today: total, showRate, showed };
  } catch (e) {
    console.error("Bookings error:", e.message);
    return { total: 0, today: 0, showRate: 0, showed: 0 };
  }
}

// ─── PULL CONVERSATIONS ─────────────────────────────────────────────
async function getConversations() {
  try {
    const data = await ghlFetch(
      `conversations/search?locationId=${GHL_LOCATION_ID}&limit=20`
    );
    const convos = data.conversations || [];
    const unread = convos.filter((c) => c.unreadCount > 0).length;
    return { total: convos.length, unread };
  } catch (e) {
    console.error("Conversations error:", e.message);
    return { total: 0, unread: 0 };
  }
}

// ─── DISCORD WEBHOOK ────────────────────────────────────────────────
async function sendDiscordBriefing(summary, type = "refresh") {
  if (!DISCORD_WEBHOOK) {
    console.log("[DASH] No Discord webhook configured, skipping");
    return;
  }

  const { leads, opportunities, bookings, conversations, alerts } = summary;
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  const dateStr = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });

  const isMorning = type === "morning";
  const isEOD = type === "eod";

  let title = "📊 DASH — Data Refresh";
  let color = 0x34D399;
  if (isMorning) {
    title = "☀️ DASH — Morning Briefing";
    color = 0xFBBF24;
  } else if (isEOD) {
    title = "🌙 DASH — End of Day Summary";
    color = 0x60A5FA;
  }

  const alertLines = (alerts || []).map(a => {
    const icon = a.level === "warning" ? "⚠️" : "ℹ️";
    return `${icon} ${a.message}`;
  }).join("\n");

  const embed = {
    title,
    description: `**${dateStr}** at **${timeStr}**`,
    color,
    fields: [
      {
        name: "📋 Leads",
        value: `**${leads?.total || 0}** total\n**${leads?.today || 0}** new today`,
        inline: true,
      },
      {
        name: "💰 Pipeline",
        value: `**${opportunities?.total || 0}** total\n**${opportunities?.open || 0}** open\n**${opportunities?.won || 0}** won · **${opportunities?.lost || 0}** lost\n£${(opportunities?.totalValue || 0).toLocaleString()} value`,
        inline: true,
      },
      {
        name: "📅 Bookings",
        value: `**${bookings?.total || 0}** today\n**${bookings?.showRate || 0}%** show rate\n**${bookings?.showed || 0}** showed`,
        inline: true,
      },
      {
        name: "💬 Conversations",
        value: `**${conversations?.total || 0}** total\n**${conversations?.unread || 0}** unread`,
        inline: true,
      },
    ],
    footer: {
      text: "ECHO GROWTH · AGENT HQ — DASH Agent",
    },
    timestamp: new Date().toISOString(),
  };

  if (alertLines) {
    embed.fields.push({
      name: "🚨 Alerts",
      value: alertLines,
      inline: false,
    });
  }

  if (isMorning) {
    const actions = [];
    if ((leads?.today || 0) === 0) actions.push("• No new leads yet — check META agent");
    if ((bookings?.showRate || 0) < 60 && (bookings?.total || 0) > 0) actions.push("• Show rate below 60% — check follow-up sequences");
    if ((conversations?.unread || 0) > 5) actions.push(`• ${conversations.unread} unread convos — needs attention`);
    if ((opportunities?.open || 0) > 20) actions.push(`• ${opportunities.open} open opps — FLUP agent should chase`);
    if (actions.length > 0) {
      embed.fields.push({
        name: "🎯 Priority Actions",
        value: actions.join("\n"),
        inline: false,
      });
    }
  }

  if (isEOD) {
    embed.fields.push({
      name: "📝 Day Wrap",
      value: `Processed **${leads?.today || 0}** new leads today\n**${bookings?.showed || 0}/${bookings?.total || 0}** bookings showed\n**${opportunities?.won || 0}** deals won today`,
      inline: false,
    });
  }

  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "DASH Agent",
        avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png",
        embeds: [embed],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[DASH] Discord webhook error:", res.status, text);
    } else {
      console.log(`[DASH] Discord ${type} briefing sent ✓`);
    }
  } catch (e) {
    console.error("[DASH] Discord webhook failed:", e.message);
  }
}

// ─── MAIN DASH PULL ─────────────────────────────────────────────────
async function runDashAgent(briefingType = "refresh") {
  console.log(`[DASH] Running at ${new Date().toLocaleTimeString()}`);

  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.error("[DASH] Missing GHL_API_KEY or GHL_LOCATION_ID");
    return null;
  }

  try {
    const [leads, opportunities, bookings, conversations] = await Promise.all([
      getLeads(),
      getOpportunities(),
      getBookings(),
      getConversations(),
    ]);

    const summary = {
      lastUpdated: new Date().toISOString(),
      leads,
      opportunities,
      bookings,
      conversations,
      alerts: [],
    };

    // Generate alerts
    if (bookings.showRate < 60 && bookings.total > 0) {
      summary.alerts.push({
        level: "warning",
        message: `Show rate at ${bookings.showRate}% — below 60% threshold`,
        agent: "DASH",
      });
    }
    if (conversations.unread > 5) {
      summary.alerts.push({
        level: "warning",
        message: `${conversations.unread} unread conversations need attention`,
        agent: "CMMS",
      });
    }
    if (leads.today === 0) {
      summary.alerts.push({
        level: "info",
        message: "No new leads today yet",
        agent: "META",
      });
    }

    dashCache = { lastUpdated: new Date(), data: summary };
    console.log(
      `[DASH] ✓ Data refreshed — ${leads.today} leads today, ${bookings.showRate}% show rate`
    );

    // Store briefing in history (only for morning/eod)
    if (briefingType === "morning" || briefingType === "eod") {
      const briefing = {
        id: Date.now(),
        type: briefingType,
        timestamp: new Date().toISOString(),
        summary: {
          leads: { total: leads.total, today: leads.today },
          opportunities: { total: opportunities.total, open: opportunities.open, won: opportunities.won, lost: opportunities.lost, totalValue: opportunities.totalValue },
          bookings: { total: bookings.total, showRate: bookings.showRate, showed: bookings.showed },
          conversations: { total: conversations.total, unread: conversations.unread },
          alerts: summary.alerts,
        },
      };
      briefingHistory = [briefing, ...briefingHistory].slice(0, 20);
      console.log(`[DASH] Briefing stored (${briefingType}) — ${briefingHistory.length} in history`);
    }

    // Send to Discord (morning + eod always)
    if (briefingType === "morning" || briefingType === "eod") {
      await sendDiscordBriefing(summary, briefingType);
    }

    return summary;
  } catch (e) {
    console.error("[DASH] Error:", e.message);
    return null;
  }
}

// ─── CRON JOBS ──────────────────────────────────────────────────────
// 7am daily briefing (UK time — server is UTC so 6am UTC = 7am BST)
cron.schedule("0 6 * * *", () => {
  console.log("[DASH] 7am briefing running...");
  runDashAgent("morning");
});

// 11pm end of day summary (10pm UTC = 11pm BST)
cron.schedule("0 22 * * *", () => {
  console.log("[DASH] 11pm summary running...");
  runDashAgent("eod");
});

// Every 15 mins refresh during business hours (Mon-Fri 7am-6pm UTC = 8am-7pm BST)
cron.schedule("*/15 7-18 * * 1-5", () => {
  runDashAgent("refresh");
});

// ─── API ROUTES ─────────────────────────────────────────────────────

// Get latest DASH data
app.get("/api/dash", async (req, res) => {
  if (!dashCache.data) {
    const data = await runDashAgent("refresh");
    return res.json(data || { error: "No data yet" });
  }
  res.json(dashCache.data);
});

// Force refresh
app.post("/api/dash/refresh", async (req, res) => {
  const data = await runDashAgent("refresh");
  res.json(data || { error: "Refresh failed" });
});

// Get briefing history
app.get("/api/dash/briefings", (req, res) => {
  res.json({
    briefings: briefingHistory,
    count: briefingHistory.length,
  });
});

// Force send a Discord briefing (for testing)
app.post("/api/dash/briefing/send", async (req, res) => {
  const type = req.body?.type || "morning";
  const data = await runDashAgent(type);
  if (data) {
    res.json({ success: true, type, message: `${type} briefing sent to Discord` });
  } else {
    res.json({ success: false, message: "Failed to generate briefing" });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    agent: "DASH",
    lastUpdated: dashCache.lastUpdated,
    locationId: GHL_LOCATION_ID ? "configured" : "missing",
    apiKey: GHL_API_KEY ? "configured" : "missing",
    discordWebhook: DISCORD_WEBHOOK ? "configured" : "missing",
    briefingCount: briefingHistory.length,
  });
});

// ─── START ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[DASH Agent] Running on port ${PORT}`);
  console.log(`[DASH Agent] Location: ${GHL_LOCATION_ID}`);
  console.log(`[DASH Agent] Discord: ${DISCORD_WEBHOOK ? "configured" : "not set"}`);
  // Run immediately on start
  runDashAgent("refresh");
});
