import dotenv from "dotenv";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { logActivity } from "./activity-log.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── READ-ONLY BY DESIGN ────────────────────────────────────────────
// ADLIB must NEVER mutate ads, pause campaigns, or modify budgets.
// Every operation here is a GET. Alert, report, suggest — never execute.
// ────────────────────────────────────────────────────────────────────

const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_WEBHOOK = process.env.ADLIB_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;
// Dedicated channel for fatigue alerts (critical). Falls back to main webhook.
const FATIGUE_WEBHOOK = process.env.ADLIB_FATIGUE_WEBHOOK || DISCORD_WEBHOOK;

const DATA_DIR = path.join(__dirname, "data");
const HISTORY_PATH = path.join(DATA_DIR, "adlib-history.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_PATH)) fs.writeFileSync(HISTORY_PATH, "[]");
}
function readHistory() { try { return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); } catch { return []; } }
function writeHistory(d) { fs.writeFileSync(HISTORY_PATH, JSON.stringify(d, null, 2)); }

async function fetchWindsorAds() {
  if (!WINDSOR_API_KEY) return [];
  try {
    const fields = [
      "date", "campaign", "adset", "ad", "source",
      "spend", "clicks", "impressions", "ctr", "cpc", "cpm",
      "conversions", "cost_per_conversion", "roas", "frequency",
    ].join(",");
    const url = `https://connectors.windsor.ai/all?api_key=${WINDSOR_API_KEY}&date_preset=last_7d&fields=${fields}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) { console.error("[ADLIB] Windsor API:", res.status); return []; }
    const data = await res.json();
    return data.data || data.rows || data || [];
  } catch (e) { console.error("[ADLIB] Windsor fetch failed:", e.message); return []; }
}

async function callOpenAI(systemPrompt, userMessage, maxTokens = 1500) {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

// ─── CREATIVE FATIGUE DETECTION ─────────────────────────────────────
// Fatigued = frequency > 3.0 AND CTR declining day-over-day, OR
//            CTR dropped >30% vs 7-day baseline.
function detectFatigue(currentRows, historyRows) {
  const fatigued = [];
  const byAd = {};
  for (const r of currentRows) {
    const id = r.ad || r.ad_id || r.creative || r.campaign;
    if (!id) continue;
    byAd[id] = r;
  }

  for (const [id, row] of Object.entries(byAd)) {
    const ctr = Number(row.ctr || 0);
    const freq = Number(row.frequency || 0);
    const spend = Number(row.spend || 0);

    // Find historical CTR for this ad from the last 7-day snapshot
    const histMatch = historyRows.find(h => (h.ad || h.ad_id || h.campaign) === id);
    const histCtr = histMatch ? Number(histMatch.ctr || 0) : null;

    const ctrDrop = histCtr && histCtr > 0 ? ((histCtr - ctr) / histCtr) * 100 : 0;

    if ((freq > 3.0 && spend > 50) || (histCtr && ctrDrop > 30 && spend > 50)) {
      fatigued.push({
        id,
        campaign: row.campaign || "Unknown",
        frequency: freq,
        ctr,
        previousCtr: histCtr,
        ctrDropPct: Math.round(ctrDrop * 10) / 10,
        spend,
      });
    }
  }
  return fatigued;
}

function summarisePerformance(rows) {
  let totalSpend = 0, totalClicks = 0, totalImps = 0, totalConv = 0;
  for (const r of rows) {
    totalSpend += Number(r.spend || 0);
    totalClicks += Number(r.clicks || 0);
    totalImps += Number(r.impressions || 0);
    totalConv += Number(r.conversions || 0);
  }
  return {
    totalSpend: Math.round(totalSpend),
    totalClicks,
    totalImps,
    totalConv,
    ctr: totalImps > 0 ? Math.round((totalClicks / totalImps) * 1000) / 10 : 0,
    cpl: totalConv > 0 ? Math.round((totalSpend / totalConv) * 100) / 100 : 0,
  };
}

function topAndBottom(rows, metric, n = 3) {
  const filtered = rows.filter(r => Number(r[metric] || 0) > 0);
  const sorted = [...filtered].sort((a, b) => Number(b[metric] || 0) - Number(a[metric] || 0));
  return { top: sorted.slice(0, n), bottom: sorted.slice(-n).reverse() };
}

async function generateTrendAnalysis(perf, topCtr, niche = "UK service businesses") {
  const prompt = `You are a creative strategist. Given the ad performance below, produce a concise "what's working in [niche] right now" report.

Return STRICT JSON:
{
  "winning_angles": ["observation 1", "..."],
  "hook_patterns_working": ["pattern 1", "..."],
  "creative_directions_to_test": ["direction 1", "..."],
  "what_to_avoid": ["..."]
}`;

  const topBlob = topCtr.map(r => `${r.campaign || r.ad}: CTR ${r.ctr}% spend £${r.spend}`).join("\n") || "(no top performers)";
  const user = `NICHE: ${niche}
7-DAY TOTALS: spend £${perf.totalSpend}, ${perf.totalClicks} clicks, ${perf.totalImps} impressions, ${perf.totalConv} conversions (CTR ${perf.ctr}%, CPL £${perf.cpl})
TOP CTR ADS:
${topBlob}`;

  const raw = await callOpenAI(prompt, user);
  if (!raw) return null;
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return { error: "parse_failed", raw }; }
}

async function postFatigueAlert(fatigued) {
  if (!FATIGUE_WEBHOOK || fatigued.length === 0) return;
  const embed = {
    title: "🚨 CRITICAL — Creative Fatigue Detected",
    description: `**${fatigued.length}** ad${fatigued.length === 1 ? "" : "s"} showing fatigue. REPORT ONLY — no auto-pause.`,
    color: 0xEF4444,
    fields: fatigued.slice(0, 10).map(f => ({
      name: `⚠️ ${f.campaign}`,
      value: `Freq: **${f.frequency}** · CTR: ${f.ctr}%${f.previousCtr ? ` (↓ ${f.ctrDropPct}% from ${f.previousCtr}%)` : ""} · Spend: £${f.spend}`,
      inline: false,
    })),
    footer: { text: "ECHO GROWTH · AGENT HQ — ADLIB · REPORT ONLY (no ad mutations)" },
    timestamp: new Date().toISOString(),
  };
  try {
    await fetch(FATIGUE_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ADLIB Alert", embeds: [embed] }),
    });
  } catch (e) { console.error("[ADLIB] Fatigue alert failed:", e.message); }
}

async function postInsights(perf, analysis, topBottom) {
  if (!DISCORD_WEBHOOK) return;
  const embed = {
    title: "📣 ADLIB Agent — Creative Intelligence",
    description: `7-day: £${perf.totalSpend} spend · ${perf.totalConv} conversions · ${perf.ctr}% CTR · £${perf.cpl} CPL`,
    color: 0xFF6B35,
    fields: [
      { name: "🏆 Top by CTR", value: topBottom.top.map(r => `${r.campaign || r.ad}: **${r.ctr}%** CTR`).join("\n").substring(0, 1024) || "—", inline: true },
      { name: "📉 Bottom by CTR", value: topBottom.bottom.map(r => `${r.campaign || r.ad}: ${r.ctr}% CTR`).join("\n").substring(0, 1024) || "—", inline: true },
    ],
    footer: { text: "ECHO GROWTH · AGENT HQ — ADLIB · REPORT ONLY" },
    timestamp: new Date().toISOString(),
  };

  if (analysis?.winning_angles) {
    embed.fields.push({ name: "✨ Winning Angles", value: analysis.winning_angles.map(a => `› ${a}`).join("\n").substring(0, 1024), inline: false });
  }
  if (analysis?.hook_patterns_working) {
    embed.fields.push({ name: "🪝 Hook Patterns Working", value: analysis.hook_patterns_working.map(a => `› ${a}`).join("\n").substring(0, 1024), inline: false });
  }
  if (analysis?.creative_directions_to_test) {
    embed.fields.push({ name: "🧪 Test Next", value: analysis.creative_directions_to_test.map(a => `› ${a}`).join("\n").substring(0, 1024), inline: false });
  }
  if (analysis?.what_to_avoid) {
    embed.fields.push({ name: "🛑 Avoid", value: analysis.what_to_avoid.map(a => `› ${a}`).join("\n").substring(0, 1024), inline: false });
  }

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ADLIB Agent", embeds: [embed] }),
    });
  } catch (e) { console.error("[ADLIB] Discord failed:", e.message); }
}

export async function runAdlibScan() {
  ensureDataDir();
  if (!WINDSOR_API_KEY) {
    console.log("[ADLIB] Skipped — WINDSOR_API_KEY not set");
    return null;
  }
  console.log(`[ADLIB] Daily scan at ${new Date().toLocaleTimeString()}`);

  const rows = await fetchWindsorAds();
  const history = readHistory();
  const previous = history[0]?.rows || [];

  const fatigued = detectFatigue(rows, previous);
  const perf = summarisePerformance(rows);
  const topBottom = topAndBottom(rows, "ctr");
  const analysis = await generateTrendAnalysis(perf, topBottom.top);

  // Alerts first — fatigue is critical
  if (fatigued.length > 0) await postFatigueAlert(fatigued);
  await postInsights(perf, analysis, topBottom);

  // Persist snapshot for tomorrow's diff
  history.unshift({
    timestamp: new Date().toISOString(),
    rows,
    performance: perf,
    fatigued: fatigued.length,
  });
  writeHistory(history.slice(0, 30));

  await logActivity("ADLIB", fatigued.length > 0 ? "fatigue alert" : "insight", `${rows.length} ads · ${fatigued.length} fatigued · £${perf.totalSpend} spend`);
  console.log(`[ADLIB] ✓ ${rows.length} ads · ${fatigued.length} fatigued`);

  return { performance: perf, fatigued, analysis };
}

const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  cron.schedule("0 8 * * *", () => runAdlibScan());
  console.log("[ADLIB Agent] Started — Daily 8am creative intelligence scan (READ ONLY)");
}
