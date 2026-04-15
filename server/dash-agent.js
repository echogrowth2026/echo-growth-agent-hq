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
const PORT = process.env.PORT || 3001;

// ─── CACHE ──────────────────────────────────────────────────────────
let dashCache = {
  lastUpdated: null,
  data: null,
};

// ─── GHL API HELPER ─────────────────────────────────────────────────
async function ghlFetch(endpoint) {
  const res = await fetch(`https://rest.gohighlevel.com/v1/${endpoint}`, {
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`GHL API error: ${res.status} ${endpoint}`);
  return res.json();
}

// ─── PULL CONTACTS (LEADS) ──────────────────────────────────────────
async function getLeads() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const data = await ghlFetch(`contacts/?locationId=${GHL_LOCATION_ID}&limit=100`);
    const contacts = data.contacts || [];
    const todayLeads = contacts.filter(c => new Date(c.dateAdded) >= today);
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
    const data = await ghlFetch(`opportunities/search?location_id=${GHL_LOCATION_ID}&limit=100`);
    const opps = data.opportunities || [];
    const won = opps.filter(o => o.status === "won").length;
    const lost = opps.filter(o => o.status === "lost").length;
    const open = opps.filter(o => o.status === "open").length;
    const totalValue = opps
      .filter(o => o.status === "open")
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

    if (calList.length === 0) return { total: 0, today: 0, showRate: 0 };

    const calId = calList[0].id;
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const appts = await ghlFetch(
      `calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${calId}&startTime=${startOfDay.toISOString()}&endTime=${endOfDay.toISOString()}`
    );

    const events = appts.events || [];
    const showed = events.filter(e => e.appointmentStatus === "showed").length;
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
    const data = await ghlFetch(`conversations/search?locationId=${GHL_LOCATION_ID}&limit=20`);
    const convos = data.conversations || [];
    const unread = convos.filter(c => c.unreadCount > 0).length;
    return { total: convos.length, unread };
  } catch (e) {
    console.error("Conversations error:", e.message);
    return { total: 0, unread: 0 };
  }
}

// ─── MAIN DASH PULL ─────────────────────────────────────────────────
async function runDashAgent() {
  console.log(`[DASH] Running at ${new Date().toLocaleTimeString()}`);
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
    if (bookings.showRate < 60) {
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
    console.log(`[DASH] ✓ Data refreshed — ${leads.today} leads today, ${bookings.showRate}% show rate`);
    return summary;
  } catch (e) {
    console.error("[DASH] Error:", e.message);
    return null;
  }
}

// ─── CRON JOBS ──────────────────────────────────────────────────────
// 7am daily briefing
cron.schedule("0 7 * * *", () => {
  console.log("[DASH] 7am briefing running...");
  runDashAgent();
});

// 11pm end of day summary
cron.schedule("0 23 * * *", () => {
  console.log("[DASH] 11pm summary running...");
  runDashAgent();
});

// Every 15 mins refresh during business hours
cron.schedule("*/15 8-18 * * 1-5", () => {
  runDashAgent();
});

// ─── API ROUTES ─────────────────────────────────────────────────────

// Get latest DASH data
app.get("/api/dash", async (req, res) => {
  if (!dashCache.data) {
    const data = await runDashAgent();
    return res.json(data || { error: "No data yet" });
  }
  res.json(dashCache.data);
});

// Force refresh
app.post("/api/dash/refresh", async (req, res) => {
  const data = await runDashAgent();
  res.json(data || { error: "Refresh failed" });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    agent: "DASH",
    lastUpdated: dashCache.lastUpdated,
    locationId: GHL_LOCATION_ID ? "configured" : "missing",
    apiKey: GHL_API_KEY ? "configured" : "missing",
  });
});

// ─── START ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[DASH Agent] Running on port ${PORT}`);
  console.log(`[DASH Agent] Location: ${GHL_LOCATION_ID}`);
  // Run immediately on start
  runDashAgent();
});
