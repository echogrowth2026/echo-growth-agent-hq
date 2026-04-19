// Compare DASH's cached /api/dash snapshot against a fresh pull
// directly from the GHL API. Writes a markdown report to
// server/data/diagnostics/ and returns { ok, path, summary }.
//
// No cron — callable only via the /api/diagnostics/data-audit route.
// Designed to be read by a human, not parsed by another agent, so
// the output is markdown with a diff table at the top.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(__dirname, "..", "data", "diagnostics");

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

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
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GHL ${res.status} ${endpoint}`);
  return res.json();
}

async function pullLiveGhl() {
  // Total contacts — use the search endpoint's `total` if present,
  // otherwise count what we can see (limit=100 capped).
  const contactsData = await ghlFetch(`contacts/?locationId=${GHL_LOCATION_ID}&limit=100`);
  const contacts = contactsData.contacts || [];
  const contactsTotal = contactsData.meta?.total ?? contactsData.total ?? contacts.length;

  const pipelinesData = await ghlFetch(`opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
  const pipelines = pipelinesData.pipelines || [];

  let oppsTotal = 0, oppsOpen = 0, oppsWon = 0, oppsLost = 0, oppsValue = 0;
  for (const p of pipelines) {
    const opData = await ghlFetch(`opportunities/search?location_id=${GHL_LOCATION_ID}`, {
      method: "POST",
      body: { locationId: GHL_LOCATION_ID, pipeline_id: p.id, limit: 100 },
    }).catch(() => ({ opportunities: [] }));
    const opps = opData.opportunities || [];
    oppsTotal += opps.length;
    oppsOpen += opps.filter(o => o.status === "open").length;
    oppsWon += opps.filter(o => o.status === "won").length;
    oppsLost += opps.filter(o => o.status === "lost").length;
    oppsValue += opps.filter(o => o.status === "open").reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0);
  }

  const calendarsData = await ghlFetch(`calendars/?locationId=${GHL_LOCATION_ID}`);
  const calendars = calendarsData.calendars || [];
  let bookingsToday = 0, bookingsShowed = 0;
  if (calendars.length > 0) {
    const calId = calendars[0].id;
    const now = new Date();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    const apptData = await ghlFetch(
      `calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${calId}&startTime=${start.getTime()}&endTime=${end.getTime()}`,
    ).catch(() => ({ events: [] }));
    const events = apptData.events || [];
    bookingsToday = events.length;
    bookingsShowed = events.filter(e => e.appointmentStatus === "showed").length;
  }

  const convoData = await ghlFetch(`conversations/search?locationId=${GHL_LOCATION_ID}&limit=20`);
  const convos = convoData.conversations || [];

  return {
    contactsTotal,
    pipelinesCount: pipelines.length,
    oppsTotal,
    oppsOpen,
    oppsWon,
    oppsLost,
    oppsValue,
    bookingsToday,
    bookingsShowed,
    conversationsTotal: convos.length,
    conversationsUnread: convos.filter(c => (c.unreadCount || 0) > 0).length,
  };
}

function extractCache(cache) {
  const data = cache?.data;
  if (!data) return null;
  return {
    lastUpdated: cache.lastUpdated,
    contactsTotal: data.leads?.total || 0,
    pipelinesCount: data.opportunities?.pipelines?.length || 0,
    oppsTotal: data.opportunities?.total || 0,
    oppsOpen: data.opportunities?.open || 0,
    oppsWon: data.opportunities?.won || 0,
    oppsLost: data.opportunities?.lost || 0,
    oppsValue: data.opportunities?.totalValue || 0,
    bookingsToday: data.bookings?.total || 0,
    bookingsShowed: data.bookings?.showed || 0,
    conversationsTotal: data.conversations?.total || 0,
    conversationsUnread: data.conversations?.unread || 0,
  };
}

function diffRow(field, cached, live) {
  const match = cached === live;
  return { field, cached, live, match };
}

function buildReport({ cacheTs, rows, stalenessSec }) {
  const ts = new Date().toISOString();
  const mismatchCount = rows.filter(r => !r.match).length;
  const status = mismatchCount === 0 ? "✅ CLEAN" : `⚠️ ${mismatchCount} field(s) drifted`;

  const lines = [];
  lines.push(`# DASH Data Audit — ${ts}`);
  lines.push("");
  lines.push(`**Status:** ${status}`);
  lines.push(`**Cache last updated:** ${cacheTs || "(never)"}`);
  lines.push(`**Cache age:** ${stalenessSec != null ? `${stalenessSec}s` : "(unknown)"}`);
  lines.push("");
  lines.push("| Field | DASH cache | Live GHL | Match? |");
  lines.push("|---|---:|---:|:---:|");
  for (const r of rows) {
    const cached = r.cached == null ? "—" : String(r.cached);
    const live = r.live == null ? "—" : String(r.live);
    const mark = r.match ? "✅" : "❌";
    lines.push(`| ${r.field} | ${cached} | ${live} | ${mark} |`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("- `contactsTotal` via GHL falls back to `meta.total` or `total`; if neither is returned, counts only the first 100 (matches DASH's `getLeads` behaviour).");
  lines.push("- `oppsValue` is the sum of `monetaryValue` on open opportunities across all pipelines.");
  lines.push("- `bookingsToday` uses the first calendar in `calendars/list`, same as DASH's `getBookings`.");
  lines.push("- Cache staleness > 900s during business hours indicates DASH's 15-min refresh cron didn't fire.");
  return lines.join("\n");
}

export async function runDataAudit({ dashCache } = {}) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    return { ok: false, error: "GHL_API_KEY or GHL_LOCATION_ID missing" };
  }
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

  const cache = extractCache(dashCache);
  const stalenessSec = cache?.lastUpdated
    ? Math.round((Date.now() - new Date(cache.lastUpdated).getTime()) / 1000)
    : null;

  let live;
  try { live = await pullLiveGhl(); }
  catch (e) { return { ok: false, error: `live pull failed: ${e.message}` }; }

  const fields = [
    "contactsTotal", "pipelinesCount",
    "oppsTotal", "oppsOpen", "oppsWon", "oppsLost", "oppsValue",
    "bookingsToday", "bookingsShowed",
    "conversationsTotal", "conversationsUnread",
  ];
  const rows = fields.map(f => diffRow(f, cache?.[f] ?? null, live[f] ?? null));

  const report = buildReport({
    cacheTs: cache?.lastUpdated || null,
    rows,
    stalenessSec,
  });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `data-audit-${ts}.md`;
  const fullPath = path.join(REPORT_DIR, fileName);
  fs.writeFileSync(fullPath, report);

  const mismatches = rows.filter(r => !r.match).length;
  return {
    ok: true,
    path: fullPath,
    relativePath: path.relative(path.resolve(__dirname, "..", ".."), fullPath),
    stalenessSec,
    mismatches,
    summary: mismatches === 0 ? "All tracked fields match." : `${mismatches} field(s) drifted between cache and live.`,
    rows,
  };
}
