import dotenv from "dotenv";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { logActivity } from "./activity-log.js";
import { postToDiscord } from "./discord-post.js";

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

// Latest-snapshot accessors used by DASH's /api/dash/ad-stats and by
// COPY/CRTV when they want real performance context.
export function getLatestSnapshot() {
  ensureDataDir();
  const h = readHistory();
  return h[0] || null;
}

export function getLatestPerformance() {
  const s = getLatestSnapshot();
  return s?.performance || null;
}

export function getLatestRows() {
  const s = getLatestSnapshot();
  return s?.rows || [];
}

export function getTopCampaigns(metric = "ctr", n = 5) {
  const rows = getLatestRows();
  const filtered = rows.filter(r => Number(r[metric] || 0) > 0);
  return [...filtered]
    .sort((a, b) => Number(b[metric] || 0) - Number(a[metric] || 0))
    .slice(0, n)
    .map(r => ({
      campaign: r.campaign || r.ad,
      spend: Number(r.spend || 0),
      ctr: Number(r.ctr || 0),
      cpc: Number(r.cpc || 0),
      conversions: Number(r.conversions || 0),
      cpl: Number(r.cost_per_conversion || 0),
    }));
}

// Windsor.ai URL shape (verified working with last_7d preset):
//   /all?api_key=…&date_preset=last_7d&fields=…&source=facebook
// We try the richer field set first; if Windsor rejects it we fall
// back to the minimal set Sam confirmed, and compute CTR/CPL locally
// from clicks/impressions/spend/conversions where possible.
const WINDSOR_BASE = "https://connectors.windsor.ai/all";
const WINDSOR_PRIMARY_FIELDS = [
  "account_name", "campaign", "clicks", "datasource", "date", "source", "spend",
  "impressions", "conversions", "ctr", "cpc", "cost_per_conversion",
];
// Verified working minimal set.
const WINDSOR_MIN_FIELDS = [
  "account_name", "campaign", "clicks", "datasource", "date", "source", "spend",
];

function buildWindsorUrl({ fields, preset = "last_7d", extra = {} }) {
  const qs = new URLSearchParams({
    api_key: WINDSOR_API_KEY,
    date_preset: preset,
    fields: fields.join(","),
    source: "facebook",
    ...extra,
  });
  return `${WINDSOR_BASE}?${qs.toString()}`;
}

async function fetchWindsorOnce(fields, preset = "last_7d") {
  const url = buildWindsorUrl({ fields, preset });
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface the body so next run's logs pinpoint the offending param
    console.error(`[ADLIB] Windsor ${res.status} — body: ${text.substring(0, 500)}`);
    return { ok: false, status: res.status, body: text };
  }
  try {
    const data = JSON.parse(text);
    const rows = data.data || data.rows || data || [];
    return { ok: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    console.error("[ADLIB] Windsor returned non-JSON:", text.substring(0, 200));
    return { ok: false, status: 200, body: text };
  }
}

export async function fetchWindsorAds() {
  if (!WINDSOR_API_KEY) return [];
  // Primary — verified working URL.
  let r = await fetchWindsorOnce(WINDSOR_PRIMARY_FIELDS, "last_7d");
  if (r.ok) return r.rows;

  // Retry with the ultra-minimal field set.
  console.warn("[ADLIB] Primary Windsor call failed, retrying with minimal fields…");
  r = await fetchWindsorOnce(WINDSOR_MIN_FIELDS, "last_7d");
  if (r.ok) return r.rows;

  // Final retry with a longer window in case last_7d has no data.
  console.warn("[ADLIB] Minimal retry failed, trying last_30d…");
  r = await fetchWindsorOnce(WINDSOR_MIN_FIELDS, "last_30d");
  if (r.ok) return r.rows;

  console.error(`[ADLIB] All Windsor attempts failed (last status ${r.status})`);
  return [];
}

// Probe helper — callable via /api/adlib/probe for quick diagnosis.
export async function probeWindsor() {
  if (!WINDSOR_API_KEY) return { ok: false, reason: "WINDSOR_API_KEY not set" };
  const attempts = [
    { label: "primary",  fields: WINDSOR_PRIMARY_FIELDS, preset: "last_7d" },
    { label: "minimal",  fields: WINDSOR_MIN_FIELDS,     preset: "last_7d" },
    { label: "last_30",  fields: WINDSOR_MIN_FIELDS,     preset: "last_30d" },
    { label: "today",    fields: WINDSOR_MIN_FIELDS,     preset: "today" },
    { label: "no_source",fields: WINDSOR_MIN_FIELDS,     preset: "last_7d", stripSource: true },
  ];
  const results = [];
  for (const a of attempts) {
    try {
      const qs = new URLSearchParams({
        api_key: WINDSOR_API_KEY,
        date_preset: a.preset,
        fields: a.fields.join(","),
        ...(a.stripSource ? {} : { source: "facebook" }),
      });
      const url = `${WINDSOR_BASE}?${qs.toString()}`;
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      const body = await res.text();
      results.push({
        label: a.label,
        status: res.status,
        ok: res.ok,
        rowCount: res.ok ? (JSON.parse(body).data?.length || JSON.parse(body).rows?.length || 0) : 0,
        bodyPreview: body.substring(0, 250),
      });
    } catch (e) {
      results.push({ label: a.label, ok: false, error: e.message });
    }
  }
  return { attempts: results };
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
    totalSpend: Math.round(totalSpend * 100) / 100,
    totalClicks,
    totalImps,
    totalConv,
    // Derived client-side so minimal field set still yields CTR/CPL
    // (these come back 0 only when the underlying raw counts are 0).
    ctr: totalImps > 0 ? Math.round((totalClicks / totalImps) * 1000) / 10 : 0,
    cpc: totalClicks > 0 ? Math.round((totalSpend / totalClicks) * 100) / 100 : 0,
    cpl: totalConv > 0 ? Math.round((totalSpend / totalConv) * 100) / 100 : 0,
    campaigns: new Set(rows.map(r => r.campaign).filter(Boolean)).size,
    hasRichFields: rows.length > 0 && rows.some(r => r.impressions || r.conversions),
  };
}

// When Windsor omits CTR/CPC on a row (minimal field set), derive
// them from clicks/impressions/spend so downstream top/bottom sorts
// still have something to rank by.
function enrichRows(rows) {
  return rows.map(r => {
    const clicks = Number(r.clicks || 0);
    const imps = Number(r.impressions || 0);
    const spend = Number(r.spend || 0);
    const conv = Number(r.conversions || 0);
    const ctr = r.ctr != null && r.ctr !== ""
      ? Number(r.ctr)
      : (imps > 0 ? Math.round((clicks / imps) * 1000) / 10 : 0);
    const cpc = r.cpc != null && r.cpc !== ""
      ? Number(r.cpc)
      : (clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : 0);
    const cpl = r.cost_per_conversion != null && r.cost_per_conversion !== ""
      ? Number(r.cost_per_conversion)
      : (conv > 0 ? Math.round((spend / conv) * 100) / 100 : 0);
    return { ...r, ctr, cpc, cost_per_conversion: cpl };
  });
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
  await postToDiscord("ADLIB", { username: "ADLIB Alert", embeds: [embed] });
}

async function postInsights(perf, analysis, topBottom) {
  if (!DISCORD_WEBHOOK) return;
  const embed = {
    title: "📣 ADLIB Agent — Creative Intelligence",
    description: `7-day Meta: £${perf.totalSpend.toLocaleString()} spend · ${perf.campaigns || 0} campaigns · ${perf.totalConv} conversions · CTR ${perf.ctr}% · CPC £${perf.cpc} · CPL £${perf.cpl}`,
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

  await postToDiscord("ADLIB", { username: "ADLIB Agent", embeds: [embed] });
}

export async function runAdlibScan() {
  ensureDataDir();
  if (!WINDSOR_API_KEY) {
    console.log("[ADLIB] Skipped — WINDSOR_API_KEY not set");
    return null;
  }
  console.log(`[ADLIB] Daily scan at ${new Date().toLocaleTimeString()}`);

  const rawRows = await fetchWindsorAds();
  const rows = enrichRows(rawRows);
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
