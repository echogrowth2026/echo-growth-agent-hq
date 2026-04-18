import dotenv from "dotenv";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { logActivity } from "./activity-log.js";
import { listApproved as listApprovedCopy } from "./copy-agent.js";
import { getLatestPerformance, getTopCampaigns } from "./adlib-agent.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_WEBHOOK = process.env.CRTV_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;

const DATA_DIR = path.join(__dirname, "data");
const PENDING_PATH = path.join(DATA_DIR, "pending-creative.json");
const APPROVED_PATH = path.join(DATA_DIR, "approved-creative.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PENDING_PATH)) fs.writeFileSync(PENDING_PATH, "[]");
  if (!fs.existsSync(APPROVED_PATH)) fs.writeFileSync(APPROVED_PATH, "[]");
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; } }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

const TEAM_ASSIGNMENTS = {
  reels: "Kieran",
  tiktok: "Kieran",
  youtube_shorts: "Mason",
  face_to_camera: "Eric",
};

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
    if (!res.ok) { console.error("[CRTV] OpenAI error:", res.status); return null; }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) { console.error("[CRTV] OpenAI failed:", e.message); return null; }
}

export async function generateCreative(input = {}) {
  ensureDataDir();
  const niche = input.niche || "B2B service businesses";
  const approvedContext = input.approvedCopy || listApprovedCopy().slice(0, 3);

  // Pull winning-creative signal from real Windsor performance
  let winningContext = input.winningCreative;
  if (!winningContext) {
    const perf = getLatestPerformance();
    const top = getTopCampaigns("ctr", 3);
    winningContext = perf
      ? `7-day Meta performance: CTR ${perf.ctr}%, CPL £${perf.cpl}. Top-CTR campaigns to echo: ${top.map(t => `"${t.campaign}" (${t.ctr}% CTR, ${t.conversions} conv @ £${t.cpl} CPL)`).join(" · ") || "none"}`
      : "No Windsor data — write to a cold audience";
  }

  const copyBlob = approvedContext.map(c => {
    const h = c.output?.headlines?.slice(0, 2).join(" / ") || "";
    const a = c.output?.angle_rewrites?.[0]?.copy || "";
    return `- ${h} | ${a}`;
  }).join("\n") || "(no approved copy yet)";

  const prompt = `You are the creative director at Echo Growth. Produce a creative brief batch for the content team.

Team members and their formats:
- Kieran: Instagram Reels + TikTok (face-to-camera, punchy)
- Mason: YouTube Shorts (more context, storytelling)
- Eric: Face-to-camera long-ish content

Rules: British English. Tight, direct, no cringe. No AI-speak. 3-second hooks must be concrete (not "Here's why...").

Return STRICT JSON:
{
  "reels": [
    { "hook": "...", "body": "...", "cta": "...", "assigned_to": "Kieran" }
  ],
  "youtube_shorts": [
    { "hook": "...", "body": "...", "cta": "...", "assigned_to": "Mason" }
  ],
  "face_to_camera": [
    { "hook": "...", "body": "...", "cta": "...", "assigned_to": "Eric" }
  ],
  "hook_variations": ["10 three-second openers to test"],
  "brief": "<2-3 sentence summary of the creative direction and why>"
}

Produce 2 reels, 2 youtube shorts, 1 face-to-camera, 10 hook variations.`;

  const user = `NICHE: ${niche}
APPROVED COPY CONTEXT:
${copyBlob}
WINNING CREATIVE SIGNAL: ${winningContext}`;

  const raw = await callOpenAI(prompt, user);
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return { error: "parse_failed", raw };
  }

  const entry = {
    id: `crtv_${Date.now()}`,
    timestamp: new Date().toISOString(),
    input: { niche, winningContext },
    output: parsed,
    status: "pending",
  };

  const pending = readJson(PENDING_PATH);
  pending.unshift(entry);
  writeJson(PENDING_PATH, pending.slice(0, 50));

  await postToDiscord(entry);
  await logActivity("CRTV", "brief generated", `${niche}`);
  return entry;
}

async function postToDiscord(entry) {
  if (!DISCORD_WEBHOOK) return;
  const o = entry.output || {};
  const fmt = (items = []) => items.map(i => `**${i.hook}**\n${i.body}\n_CTA: ${i.cta}_ → ${i.assigned_to}`).join("\n\n").substring(0, 1024) || "—";

  const embed = {
    title: "🎨 CRTV Agent — Creative Brief",
    description: o.brief || `ID: \`${entry.id}\``,
    color: 0xFB923C,
    fields: [
      { name: `🎬 Reels (Kieran)`, value: fmt(o.reels), inline: false },
      { name: `📺 YouTube Shorts (Mason)`, value: fmt(o.youtube_shorts), inline: false },
      { name: `🎙️ Face to Camera (Eric)`, value: fmt(o.face_to_camera), inline: false },
      { name: `🪝 Hook Variations`, value: (o.hook_variations || []).map((h, i) => `${i + 1}. ${h}`).join("\n").substring(0, 1024) || "—", inline: false },
    ],
    footer: { text: "ECHO GROWTH · AGENT HQ — CRTV · Review before filming" },
    timestamp: new Date().toISOString(),
  };
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "CRTV Agent", embeds: [embed] }),
    });
  } catch (e) { console.error("[CRTV] Discord failed:", e.message); }
}

export function approveCreative(id, feedback = "") {
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

export function rejectCreative(id, feedback = "") {
  ensureDataDir();
  const pending = readJson(PENDING_PATH);
  const idx = pending.findIndex(e => e.id === id);
  if (idx === -1) return null;
  const entry = { ...pending[idx], status: "rejected", rejectedAt: new Date().toISOString(), feedback };
  pending.splice(idx, 1);
  writeJson(PENDING_PATH, pending);
  return entry;
}

export function listPendingCreative() { ensureDataDir(); return readJson(PENDING_PATH); }
export function listApprovedCreative() { ensureDataDir(); return readJson(APPROVED_PATH); }

const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  // Runs after COPY's 10am, gives it a 30-min head start
  cron.schedule("30 10 * * 1-5", () => generateCreative());
  console.log("[CRTV Agent] Started — Daily 10:30am brief generation Mon-Fri");
  console.log(`[CRTV Agent] Team assignments:`, TEAM_ASSIGNMENTS);
}
