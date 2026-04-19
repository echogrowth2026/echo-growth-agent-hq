// N8N AGENT — generates n8n workflow JSON from natural-language
// descriptions. READ-ONLY to the outside world: nothing is deployed
// anywhere; every generated workflow lands in data/automations/ and
// the review queue. Sam exports the JSON manually (for now).

import dotenv from "dotenv";
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
const DISCORD_WEBHOOK = process.env.N8N_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;

const DATA_DIR = path.join(__dirname, "data", "automations");
function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

const SYSTEM_PROMPT = `You generate valid n8n workflow JSON.

Schema rules:
- Top-level: { "name": string, "nodes": [...], "connections": {...}, "active": false, "settings": {} }
- Each node has: { id (uuid-like), name (unique), type (e.g. "n8n-nodes-base.webhook"), typeVersion, position: [x,y], parameters }
- Nodes must be connected via the "connections" object: { "<sourceNodeName>": { "main": [[{ "node": "<targetNodeName>", "type": "main", "index": 0 }]] } }
- Use these common node types:
  - Triggers: n8n-nodes-base.webhook, n8n-nodes-base.scheduleTrigger, n8n-nodes-base.manualTrigger, n8n-nodes-base.emailReadImap
  - Action: n8n-nodes-base.httpRequest, n8n-nodes-base.set, n8n-nodes-base.if, n8n-nodes-base.code, n8n-nodes-base.merge, n8n-nodes-base.switch
  - Integrations: n8n-nodes-base.discord (use this for team notifications — NOT Slack; Sam is on Discord), n8n-nodes-base.gmail, n8n-nodes-base.googleSheets
  - GHL-like actions use n8n-nodes-base.httpRequest with base https://services.leadconnectorhq.com and Bearer GHL_API_KEY placeholder
- Position nodes left-to-right on a 300px grid (x: 250, 550, 850, 1150, ...) along y: 300.
- Parameters should be sensible defaults for the described steps; leave credentials fields empty.
- No markdown. No commentary. Respond ONLY with valid workflow JSON.`;

async function callOpenAI(user) {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 2500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      console.error(`[N8N] OpenAI ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("[N8N] OpenAI error:", e.message);
    return null;
  }
}

async function postDiscord(entry) {
  if (!DISCORD_WEBHOOK) return;
  const embed = {
    title: "⚙️ N8N — Automation Draft",
    description: `**${entry.name}**\n${entry.description || "(no description)"}\n\n**Trigger:** ${entry.trigger || "—"}\n**Steps:** ${entry.steps?.length ? entry.steps.join(" → ") : "—"}\n\nID: \`${entry.id}\` · Review in HQ before importing into n8n.`,
    color: 0x6D28D9,
    footer: { text: "ECHO GROWTH · AGENT HQ — N8N · REVIEW BEFORE DEPLOY" },
    timestamp: new Date().toISOString(),
  };
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "N8N Agent", embeds: [embed] }),
    });
  } catch (e) { console.error("[N8N] Discord failed:", e.message); }
}

export async function generateN8nWorkflow({ name, description, trigger, steps } = {}) {
  ensureDir();
  const safeName = (name || `Automation ${Date.now()}`).trim();
  const user = `Generate an n8n workflow:
Name: ${safeName}
Description: ${description || "(none provided)"}
Trigger: ${trigger || "manual"}
Steps: ${Array.isArray(steps) ? steps.join(" → ") : (steps || "(let the model decide)")}`;

  const raw = await callOpenAI(user);
  let workflow = null;
  if (raw) {
    try { workflow = JSON.parse(raw); }
    catch (e) { console.error("[N8N] JSON parse failed:", e.message); }
  }

  const id = `n8n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const entry = {
    id,
    name: safeName,
    description: description || "",
    trigger: trigger || null,
    steps: Array.isArray(steps) ? steps : (steps ? [String(steps)] : []),
    workflow: workflow || { error: "generation_failed" },
    status: workflow ? "pending" : "failed",
    createdAt: new Date().toISOString(),
  };

  const filePath = path.join(DATA_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));

  // Enqueue for review — the review queue tracks decisions, the file
  // on disk tracks the actual workflow JSON for export.
  await addToReview("N8N", "automation", {
    automationId: id,
    name: safeName,
    description,
    trigger,
    steps: entry.steps,
    workflow: workflow ? { nodes: workflow.nodes?.length || 0, summary: "see download" } : null,
  });

  await postDiscord(entry);
  await logActivity("N8N", workflow ? "automation drafted" : "draft failed", `${safeName} · ${entry.steps.join(" → ") || "no steps"}`);

  return entry;
}

export function listN8nWorkflows() {
  ensureDir();
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function getN8nWorkflow(id) {
  ensureDir();
  const p = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

// No cron — on demand only. Kept alive when launched as a child
// process so the launcher doesn't restart it in a loop.
const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  console.log("[N8N Agent] Started — on-demand workflow generator (no schedule)");
  console.log(`[N8N] OpenAI: ${OPENAI_API_KEY ? "✓" : "✗"} · Webhook: ${DISCORD_WEBHOOK ? "✓" : "✗"}`);
  setInterval(() => {}, 1 << 30);
}
