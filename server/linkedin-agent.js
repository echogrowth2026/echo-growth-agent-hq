// LINKEDIN AGENT — content generation only. Every day at 8am UTC we
// pick a rotating content type, pull fresh signal from STRT/ADLIB/
// ADSPY if available, draft a post via OpenAI, and queue it for Sam
// to review + manually publish. No direct LinkedIn API calls.

import dotenv from "dotenv";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { logActivity } from "./activity-log.js";
import { addToReview } from "./review-queue.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_WEBHOOK = process.env.LINKEDIN_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;

const DATA_DIR = path.join(__dirname, "data", "linkedin");
const QUEUE_PATH = path.join(DATA_DIR, "queue.json");
function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(QUEUE_PATH)) fs.writeFileSync(QUEUE_PATH, "[]");
}
function readQueue() { try { return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")); } catch { return []; } }
function writeQueue(d) { fs.writeFileSync(QUEUE_PATH, JSON.stringify(d.slice(0, 200), null, 2)); }

const CONTENT_TYPES = [
  {
    key: "thought-leadership",
    prompt: "Write a confident thought-leadership post about a sharp observation in B2B service-business marketing. Open with a single-line hook. End with a question.",
  },
  {
    key: "case-study",
    prompt: "Write a LinkedIn post about an anonymised client insight (e.g. 'a law firm we work with saw X after Y'). Be specific with numbers, keep names generic. End with the lesson others can apply.",
  },
  {
    key: "hot-take",
    prompt: "Write a punchy hot-take post challenging a common piece of marketing advice. Be provocative but defensible — back the claim with one reason.",
  },
  {
    key: "personal-story",
    prompt: "Write a short, grounded first-person story about running a marketing agency. Real and specific, no false humility. End with one takeaway.",
  },
  {
    key: "engagement-question",
    prompt: "Write a LinkedIn post that's mostly a question designed to get replies. Give just enough context (2-3 sentences) then ask an open question founders will want to answer.",
  },
];

function pickContentType(date = new Date()) {
  const day = Math.floor(date.getTime() / (1000 * 60 * 60 * 24));
  return CONTENT_TYPES[day % CONTENT_TYPES.length];
}

const SYSTEM_PROMPT = `You are writing LinkedIn posts for Sam at Echo Growth, a UK AI-native marketing agency for service businesses.

Voice: confident, specific, British English, a little dry, never cringe. No emojis in the body (a single one at the end is fine). No buzzwords ("synergy", "leverage", "game-changer"). No "In today's fast-paced world..." openers.

Format:
- Hook line (strong, 1 line)
- Blank line
- Body with line breaks every 1-2 sentences (LinkedIn rewards whitespace)
- One CTA line
- Blank line
- 3-5 hashtags, all lowercase, no spammy tags

Return STRICT JSON:
{"hook": "...", "body": "...", "cta": "...", "hashtags": ["#tag1", ...], "full_text": "the complete assembled post ready to paste"}`;

async function callOpenAI({ type, topic, signal }) {
  if (!OPENAI_API_KEY) return null;
  const user = `Content type: ${type.key} — ${type.prompt}
${topic ? `Topic angle: ${topic}` : ""}
${signal ? `Fresh performance signal to weave in (if helpful): ${signal}` : ""}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) { console.error(`[LINKEDIN] OpenAI ${res.status}`); return null; }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || null;
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (e) { console.error("[LINKEDIN] JSON parse failed:", e.message); return null; }
  } catch (e) {
    console.error("[LINKEDIN] OpenAI error:", e.message);
    return null;
  }
}

async function fetchSignal() {
  // Pull ADLIB perf if available — imported lazily so this module
  // doesn't crash if ADLIB hasn't run yet.
  try {
    const { getLatestPerformance } = await import("./adlib-agent.js");
    const perf = getLatestPerformance();
    if (perf) {
      return `7-day Meta perf: £${perf.totalSpend} spend, CTR ${perf.ctr}%, CPL £${perf.cpl}`;
    }
  } catch {}
  return null;
}

async function postDiscord(entry) {
  if (!DISCORD_WEBHOOK) return;
  const preview = (entry.content?.full_text || "(draft)").substring(0, 900);
  const embed = {
    title: `💼 LinkedIn — ${entry.type}`,
    description: `\`\`\`\n${preview}\n\`\`\``,
    color: 0x0A66C2,
    fields: [
      { name: "ID", value: `\`${entry.id}\``, inline: true },
      { name: "Status", value: entry.status, inline: true },
    ],
    footer: { text: "ECHO GROWTH · AGENT HQ — LINKEDIN · COPY & POST MANUALLY" },
    timestamp: new Date().toISOString(),
  };
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "LinkedIn Agent", embeds: [embed] }),
    });
  } catch (e) { console.error("[LINKEDIN] Discord failed:", e.message); }
}

export async function generateLinkedinPost({ topic = null, style = null } = {}) {
  ensure();
  const type = style ? (CONTENT_TYPES.find(t => t.key === style) || pickContentType()) : pickContentType();
  const signal = await fetchSignal();
  const content = await callOpenAI({ type, topic, signal });

  const entry = {
    id: `li_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: type.key,
    topic: topic || null,
    signal,
    content: content || { error: "generation_failed" },
    status: content ? "pending" : "failed",
    createdAt: new Date().toISOString(),
  };

  const queue = readQueue();
  queue.unshift(entry);
  writeQueue(queue);

  await addToReview("LINKEDIN", "linkedin", {
    postId: entry.id,
    type: type.key,
    topic,
    full_text: content?.full_text || null,
    hook: content?.hook || null,
    hashtags: content?.hashtags || [],
  });

  await postDiscord(entry);
  await logActivity("LINKEDIN", content ? "post drafted" : "draft failed", `${type.key}${topic ? ` · ${topic}` : ""}`);

  return entry;
}

export function listLinkedinQueue(limit = 50) {
  ensure();
  return readQueue().slice(0, limit);
}

export function getLinkedinPost(id) {
  ensure();
  return readQueue().find(e => e.id === id) || null;
}

function updateLinkedinPost(id, patch) {
  ensure();
  const queue = readQueue();
  const idx = queue.findIndex(e => e.id === id);
  if (idx === -1) return null;
  queue[idx] = { ...queue[idx], ...patch, updatedAt: new Date().toISOString() };
  writeQueue(queue);
  return queue[idx];
}

// ─── TWO-STEP DESKTOP POST FLOW ─────────────────────────────────────
// After Sam approves a post in the Review tab we don't auto-publish.
// Step 1 — paste the content into LinkedIn's composer on the desktop
// browser and capture a screenshot. Sam eyeballs it. Step 2 — only
// after an explicit confirm does the desktop click the Post button.
export async function prepareLinkedinDesktopPost({ postId, sendToDesktop }) {
  if (!sendToDesktop) return { ok: false, error: "desktop not connected" };
  const entry = getLinkedinPost(postId);
  if (!entry) return { ok: false, error: "post not found" };
  const text = entry.content?.full_text;
  if (!text) return { ok: false, error: "post has no full_text" };

  try {
    const result = await sendToDesktop({
      type: "BROWSER_ACTION",
      action: { service: "linkedin", type: "paste-post", content: text, postId },
    }, { timeoutMs: 120_000 });
    updateLinkedinPost(postId, { status: "awaiting_confirm", desktopStage: "pasted", lastResult: result });
    await logActivity("LINKEDIN", "pasted on desktop", `${postId} · awaiting Sam confirm`);
    return { ok: true, stage: "awaiting_confirm", screenshot: result?.screenshot || null };
  } catch (e) {
    updateLinkedinPost(postId, { status: "desktop_failed", desktopStage: "paste_failed", lastError: e.message });
    return { ok: false, error: e.message };
  }
}

export async function confirmLinkedinDesktopPost({ postId, sendToDesktop }) {
  if (!sendToDesktop) return { ok: false, error: "desktop not connected" };
  const entry = getLinkedinPost(postId);
  if (!entry) return { ok: false, error: "post not found" };
  if (entry.desktopStage !== "pasted") return { ok: false, error: `post is in stage "${entry.desktopStage || entry.status}", not ready to confirm` };

  try {
    const result = await sendToDesktop({
      type: "BROWSER_ACTION",
      action: { service: "linkedin", type: "click-post", postId },
    }, { timeoutMs: 60_000 });
    updateLinkedinPost(postId, { status: "published", desktopStage: "published", lastResult: result });
    await logActivity("LINKEDIN", "published via desktop", `${postId}`);
    return { ok: true, stage: "published", result };
  } catch (e) {
    updateLinkedinPost(postId, { status: "desktop_failed", desktopStage: "publish_failed", lastError: e.message });
    return { ok: false, error: e.message };
  }
}

export async function cancelLinkedinDesktopPost({ postId, sendToDesktop }) {
  updateLinkedinPost(postId, { status: "cancelled", desktopStage: "cancelled" });
  if (sendToDesktop) {
    try { await sendToDesktop({ type: "BROWSER_ACTION", action: { service: "linkedin", type: "cancel-post", postId } }, { timeoutMs: 20_000 }); }
    catch { /* best-effort */ }
  }
  return { ok: true, stage: "cancelled" };
}

const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  cron.schedule("0 8 * * *", () => generateLinkedinPost());
  console.log("[LINKEDIN Agent] Started — Daily 8am post draft");
  console.log(`[LINKEDIN] OpenAI: ${OPENAI_API_KEY ? "✓" : "✗"} · Webhook: ${DISCORD_WEBHOOK ? "✓" : "✗"}`);
}
