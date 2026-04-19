import dotenv from "dotenv";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { logActivity } from "./activity-log.js";
import { getLatestPerformance, getTopCampaigns } from "./adlib-agent.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_WEBHOOK = process.env.COPY_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;
const DASH_API = process.env.DASH_API || "https://echo-growth-agent-hq-production.up.railway.app";

const DATA_DIR = path.join(__dirname, "data");
const APPROVED_PATH = path.join(DATA_DIR, "approved-copy.json");
const PENDING_PATH = path.join(DATA_DIR, "pending-copy.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(APPROVED_PATH)) fs.writeFileSync(APPROVED_PATH, "[]");
  if (!fs.existsSync(PENDING_PATH)) fs.writeFileSync(PENDING_PATH, "[]");
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; } }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

async function callOpenAI(systemPrompt, userMessage, maxTokens = 1200) {
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
    if (!res.ok) { console.error("[COPY] OpenAI error:", res.status); return null; }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) { console.error("[COPY] OpenAI failed:", e.message); return null; }
}

async function getDashData() {
  try {
    const res = await fetch(`${DASH_API}/api/dash`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function generateCopy(input = {}) {
  ensureDataDir();
  const niche = input.niche || "B2B service businesses";
  const offer = input.offer || "Echo Growth lead-gen system ($8k, 90-day engagement)";
  const audience = input.audience || "founders and owners aged 30-55";

  // Pull real 7-day Windsor numbers if the caller didn't override
  let performanceNote = input.performanceNote;
  let topCampaigns = [];
  if (!performanceNote) {
    const perf = getLatestPerformance();
    topCampaigns = getTopCampaigns("ctr", 3);
    performanceNote = perf
      ? `7-day Meta: £${perf.totalSpend} spend, ${perf.totalConv} conversions, CTR ${perf.ctr}%, CPL £${perf.cpl}, CPC £${perf.cpc}. Top CTR campaigns: ${topCampaigns.map(t => `${t.campaign} (${t.ctr}% CTR, £${t.cpl} CPL)`).join(" · ") || "—"}`
      : "No Windsor data available yet";
  }

  const prompt = `You are the senior direct-response copywriter at Echo Growth (UK marketing agency selling $8k / 90-day GHL-powered acquisition systems).

Write copy variants that feel tight, British, direct. NO hype words ("revolutionary", "game-changing", "unlock"). No em-dashes. No "in today's fast-paced world".

Return STRICT JSON (no markdown fences):
{
  "headlines": ["5 distinct angles — short, specific, benefit-led"],
  "ctas": ["4 CTAs that match different funnel stages"],
  "angle_rewrites": [
    { "angle": "<hook angle name>", "copy": "<2-3 sentence ad body>" }
  ]
}

Produce 5 headlines, 4 CTAs, 3 angle rewrites.`;

  const user = `NICHE: ${niche}
OFFER: ${offer}
AUDIENCE: ${audience}
PERFORMANCE CONTEXT: ${performanceNote}`;

  const raw = await callOpenAI(prompt, user);
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return { error: "parse_failed", raw };
  }

  const entry = {
    id: `copy_${Date.now()}`,
    timestamp: new Date().toISOString(),
    input: { niche, offer, audience, performanceNote },
    output: parsed,
    status: "pending",
  };

  const pending = readJson(PENDING_PATH);
  pending.unshift(entry);
  writeJson(PENDING_PATH, pending.slice(0, 50));

  await postToDiscord(entry);
  await logActivity("COPY", "generated", `${parsed.headlines?.length || 0} headlines for ${niche}`);
  return entry;
}

async function postToDiscord(entry) {
  if (!DISCORD_WEBHOOK) return;
  const { headlines = [], ctas = [], angle_rewrites = [] } = entry.output || {};
  const embed = {
    title: "✍️ COPY Agent — Review Batch",
    description: `Niche: **${entry.input.niche}** · ID: \`${entry.id}\``,
    color: 0xA78BFA,
    fields: [
      { name: "🎯 Headlines", value: headlines.map((h, i) => `${i + 1}. ${h}`).join("\n").substring(0, 1024) || "—", inline: false },
      { name: "📣 CTAs", value: ctas.map(c => `› ${c}`).join("\n").substring(0, 1024) || "—", inline: false },
      { name: "🎨 Angle Rewrites", value: angle_rewrites.map(a => `**${a.angle}**\n${a.copy}`).join("\n\n").substring(0, 1024) || "—", inline: false },
    ],
    footer: { text: "ECHO GROWTH · AGENT HQ — COPY · Review only, nothing auto-published" },
    timestamp: new Date().toISOString(),
  };
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "COPY Agent", embeds: [embed] }),
    });
  } catch (e) { console.error("[COPY] Discord failed:", e.message); }
}

export function approveCopy(id, feedback = "") {
  ensureDataDir();
  const pending = readJson(PENDING_PATH);
  const idx = pending.findIndex(e => e.id === id);
  if (idx === -1) return null;
  const entry = { ...pending[idx], status: "approved", approvedAt: new Date().toISOString(), feedback };
  pending.splice(idx, 1);
  writeJson(PENDING_PATH, pending);
  const approved = readJson(APPROVED_PATH);
  approved.unshift(entry);
  writeJson(APPROVED_PATH, approved.slice(0, 200));
  return entry;
}

export function rejectCopy(id, feedback = "") {
  ensureDataDir();
  const pending = readJson(PENDING_PATH);
  const idx = pending.findIndex(e => e.id === id);
  if (idx === -1) return null;
  const entry = { ...pending[idx], status: "rejected", rejectedAt: new Date().toISOString(), feedback };
  pending.splice(idx, 1);
  writeJson(PENDING_PATH, pending);
  return entry;
}

export function listPending() { ensureDataDir(); return readJson(PENDING_PATH); }
export function listApproved() { ensureDataDir(); return readJson(APPROVED_PATH); }

async function runDaily() {
  console.log(`[COPY] Daily generation at ${new Date().toLocaleTimeString()}`);
  const dash = await getDashData();
  const performanceNote = dash
    ? `Current show rate ${dash.bookings?.showRate || 0}%, ${dash.leads?.today || 0} new leads today, ${dash.opportunities?.open || 0} open opps`
    : "No live data";
  await generateCopy({ performanceNote });
}

// Only register cron when this file is the main entry point (forked by launcher).
const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  cron.schedule("0 10 * * 1-5", () => runDaily());
  console.log("[COPY Agent] Started — Daily 10am generation Mon-Fri");
}
