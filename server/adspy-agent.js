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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_WEBHOOK = process.env.ADSPY_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;
const DASH_API = process.env.DASH_API || "https://echo-growth-agent-hq-production.up.railway.app";

const COMPETITIVE_DIR = path.join(__dirname, "data", "competitive");
function ensureDir() { if (!fs.existsSync(COMPETITIVE_DIR)) fs.mkdirSync(COMPETITIVE_DIR, { recursive: true }); }
function fileFor(date, niche) {
  const slug = niche.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return path.join(COMPETITIVE_DIR, `${date}_${slug}.json`);
}

async function callOpenAI(system, user, maxTokens = 1400) {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

// Best-effort pipeline→niche extraction. If a client's name matches a
// known pattern we record it; otherwise we derive a niche from pipeline
// name. This stays loose on purpose — analysis should fail soft.
async function discoverNiches() {
  try {
    const res = await fetch(`${DASH_API}/api/dash`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return ["B2B service businesses"];
    const data = await res.json();
    const niches = new Set();
    for (const p of (data.opportunities?.pipelines || [])) {
      const n = (p.name || "").trim();
      if (n && !/^(default|main|pipeline)$/i.test(n)) niches.add(n);
    }
    if (niches.size === 0) niches.add("B2B service businesses");
    return Array.from(niches);
  } catch { return ["B2B service businesses"]; }
}

export async function analyseNiche(niche) {
  ensureDir();
  const prompt = `You are a competitive intelligence analyst. The user can't see the Meta Ad Library directly, so you produce a synthesised "what's running right now" report for a given niche based on your training knowledge + common 2025 creative patterns.

Return STRICT JSON (no markdown fences):
{
  "niche": "<niche>",
  "top_ad_formats": { "static": 0, "carousel": 0, "video": 0, "reels": 0 },
  "common_hooks": ["..."],
  "common_ctas": ["..."],
  "visual_trends": {
    "colours": ["..."],
    "layouts": ["..."],
    "imagery": ["..."]
  },
  "common_offers": ["..."],
  "gaps_to_exploit": ["angles competitors are NOT using"],
  "what_is_overdone": ["tropes that have gone stale"],
  "recommendations_for_echo": ["3-5 specific creative moves we should make for this niche"]
}

Fill the numeric counts as rough percentages that sum to 100.`;

  const raw = await callOpenAI(prompt, `NICHE: ${niche}`);
  if (!raw) return null;

  let parsed;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return { error: "parse_failed", raw, niche }; }

  const entry = {
    id: `adspy_${Date.now()}`,
    niche,
    analysedAt: new Date().toISOString(),
    method: "openai-synthesis",
    analysis: parsed,
  };

  const date = entry.analysedAt.slice(0, 10);
  fs.writeFileSync(fileFor(date, niche), JSON.stringify(entry, null, 2));
  await logActivity("ADSPY", "niche analysed", niche);
  return entry;
}

export function getLatestForNiche(niche) {
  ensureDir();
  const slug = niche.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const files = fs.readdirSync(COMPETITIVE_DIR)
    .filter(f => f.includes(`_${slug}.json`))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  try { return JSON.parse(fs.readFileSync(path.join(COMPETITIVE_DIR, files[0]), "utf8")); }
  catch { return null; }
}

export function getLatestAll() {
  ensureDir();
  const today = new Date().toISOString().slice(0, 10);
  const files = fs.readdirSync(COMPETITIVE_DIR).filter(f => f.startsWith(today));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(COMPETITIVE_DIR, f), "utf8")); }
    catch { return null; }
  }).filter(Boolean);
}

async function sendDailyBrief(reports) {
  if (!DISCORD_WEBHOOK || reports.length === 0) return;
  const fields = reports.slice(0, 5).map(r => {
    const a = r.analysis || {};
    const gaps = (a.gaps_to_exploit || []).slice(0, 2).map(g => `› ${g}`).join("\n");
    const recs = (a.recommendations_for_echo || []).slice(0, 2).map(g => `› ${g}`).join("\n");
    return {
      name: `🎯 ${r.niche}`,
      value: `**Gaps:**\n${gaps || "—"}\n**Moves:**\n${recs || "—"}`.substring(0, 1024),
      inline: false,
    };
  });

  const embed = {
    title: "🕵️ ADSPY Agent — Daily Competitive Brief",
    description: `${reports.length} niche${reports.length === 1 ? "" : "s"} analysed`,
    color: 0x5865F2,
    fields,
    footer: { text: "ECHO GROWTH · AGENT HQ — ADSPY · OpenAI-synth, no scraping" },
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ADSPY Agent", embeds: [embed] }),
    });
  } catch (e) { console.error("[ADSPY] Discord failed:", e.message); }
}

export async function runDailyScan() {
  console.log(`[ADSPY] Daily scan at ${new Date().toLocaleTimeString()}`);
  const niches = await discoverNiches();
  const reports = [];
  for (const n of niches) {
    const r = await analyseNiche(n);
    if (r) reports.push(r);
  }
  await sendDailyBrief(reports);
  await logActivity("ADSPY", "daily scan", `${reports.length} niches`);
  return reports;
}

const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  // 7:30am UTC daily — runs before ADLIB's 8am scan
  cron.schedule("30 7 * * *", () => runDailyScan());
  console.log("[ADSPY Agent] Started — Daily 7:30am competitive scan (OpenAI-synth)");
}
