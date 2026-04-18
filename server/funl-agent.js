import dotenv from "dotenv";
import cron from "node-cron";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { logActivity } from "./activity-log.js";
import { generateCopy } from "./copy-agent.js";

dotenv.config();

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const DISCORD_WEBHOOK = process.env.FUNL_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;

const CONVERSION_THRESHOLD = 15; // below this % triggers a flag + COPY rewrite
let funlLog = [];

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

async function getFunnels() {
  try {
    const data = await ghlFetch(`funnels/funnel/list?locationId=${GHL_LOCATION_ID}&limit=100`);
    return data.funnels || [];
  } catch (e) {
    // Fallback: some GHL tenants expose funnels via a different path
    try {
      const data = await ghlFetch(`funnels/?locationId=${GHL_LOCATION_ID}`);
      return data.funnels || [];
    } catch (e2) {
      console.error("[FUNL] Funnel fetch failed:", e2.message);
      return [];
    }
  }
}

async function getFunnelAnalytics(funnelId) {
  // Best-effort: GHL's analytics endpoint can vary. Return whatever we can extract.
  try {
    const data = await ghlFetch(`funnels/funnel/${funnelId}/statistics?locationId=${GHL_LOCATION_ID}`);
    return data || {};
  } catch {
    return {};
  }
}

export async function runFunnelScan() {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) return null;
  console.log(`[FUNL] Daily funnel scan at ${new Date().toLocaleTimeString()}`);

  const funnels = await getFunnels();
  const tracked = [];
  const flagged = [];

  for (const f of funnels) {
    const stats = await getFunnelAnalytics(f._id || f.id);
    const views = stats.views || stats.pageViews || stats.visits || 0;
    const submissions = stats.submissions || stats.formSubmissions || stats.conversions || 0;
    const rate = views > 0 ? Math.round((submissions / views) * 100 * 10) / 10 : 0;

    const entry = {
      id: f._id || f.id,
      name: f.name || "Unnamed funnel",
      views,
      submissions,
      conversionRate: rate,
    };
    tracked.push(entry);
    if (views > 20 && rate < CONVERSION_THRESHOLD) flagged.push(entry);
  }

  const report = {
    timestamp: new Date().toISOString(),
    funnelsTracked: tracked.length,
    flagged: flagged.length,
    tracked,
    flaggedFunnels: flagged,
  };
  funlLog = [report, ...funlLog].slice(0, 50);

  await sendFunlReport(report);

  // Trigger COPY rewrites for flagged funnels
  for (const f of flagged) {
    try {
      await generateCopy({
        niche: "funnel page visitors",
        offer: `Funnel "${f.name}" — currently converting at ${f.conversionRate}%`,
        performanceNote: `Views: ${f.views}, Submissions: ${f.submissions}, Conversion: ${f.conversionRate}% (below ${CONVERSION_THRESHOLD}% threshold)`,
      });
      await logActivity("FUNL", "COPY rewrite triggered", `${f.name} @ ${f.conversionRate}%`);
    } catch (e) { console.error("[FUNL] COPY trigger failed:", e.message); }
  }

  await logActivity("FUNL", "scan complete", `${tracked.length} funnels · ${flagged.length} flagged`);
  console.log(`[FUNL] ✓ ${tracked.length} funnels · ${flagged.length} below ${CONVERSION_THRESHOLD}%`);
  return report;
}

async function sendFunlReport(report) {
  if (!DISCORD_WEBHOOK) return;

  const topPerformers = [...report.tracked].sort((a, b) => b.conversionRate - a.conversionRate).slice(0, 5);

  const embed = {
    title: "🔧 FUNL Agent — Daily Funnel Report",
    color: report.flagged > 0 ? 0xFBBF24 : 0x34D399,
    fields: [
      { name: "📊 Funnels Tracked", value: `**${report.funnelsTracked}**`, inline: true },
      { name: "⚠️ Below 15%", value: `**${report.flagged}**`, inline: true },
      { name: "🏆 Top Performers", value: topPerformers.map(f => `**${f.name}** — ${f.conversionRate}% (${f.submissions}/${f.views})`).join("\n").substring(0, 1024) || "—", inline: false },
    ],
    footer: { text: "ECHO GROWTH · AGENT HQ — FUNL" },
    timestamp: new Date().toISOString(),
  };

  if (report.flaggedFunnels.length > 0) {
    embed.fields.push({
      name: "🚨 Flagged (COPY triggered)",
      value: report.flaggedFunnels.map(f => `**${f.name}** — ${f.conversionRate}% (${f.submissions}/${f.views} views)`).join("\n").substring(0, 1024),
      inline: false,
    });
  }

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "FUNL Agent", embeds: [embed] }),
    });
  } catch (e) { console.error("[FUNL] Discord failed:", e.message); }
}

export { funlLog };

const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  cron.schedule("0 11 * * 1-5", () => runFunnelScan());
  console.log("[FUNL Agent] Started — Daily 11am funnel conversion tracker");
}
