// server/csm-kb-refresh.js
// Scheduled (every 72h) knowledge-base refresh for the CSM agent. Pulls
// each registered client's Discord channel activity, preserves any
// manually-seeded Meta ad data, runs a Claude summary, and atomically
// writes server/kb/<slug>.json. Read-only against Discord; never writes.
import fs from "fs/promises";
import path from "path";
import cron from "node-cron";
import { Client as DiscordClient, GatewayIntentBits } from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { postToDiscord } from "./discord-post.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.join(__dirname, "kb");
const REGISTRY = path.join(KB_DIR, "_clients.json");
const WINDOW_HOURS = 72;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── DISCORD CHANNEL ACTIVITY ───────────────────────────────────────
async function pullChannelActivity(discord, channelId) {
  if (!channelId) return { skipped: true, reason: "no channel_id" };
  try {
    const channel = await discord.channels.fetch(channelId);
    if (!channel?.isTextBased()) return { skipped: true, reason: "not text channel" };

    const cutoff = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;
    const messages = [];
    let lastId;
    for (let i = 0; i < 5; i++) {
      const batch = await channel.messages.fetch({ limit: 100, before: lastId });
      if (batch.size === 0) break;
      let hitCutoff = false;
      for (const msg of batch.values()) {
        if (msg.createdTimestamp < cutoff) { hitCutoff = true; break; }
        messages.push({
          author: msg.author.username,
          author_is_bot: msg.author.bot,
          content: msg.content,
          timestamp: msg.createdAt.toISOString(),
          attachments: msg.attachments.size,
        });
      }
      if (hitCutoff) break;
      lastId = batch.last()?.id;
    }
    return { ok: true, messages };
  } catch (err) {
    console.error(`[KB-REFRESH] Channel pull failed for ${channelId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// ─── LOAD EXISTING META DATA (seeded manually, or from future Brief E) ──
async function loadExistingMeta(clientSlug) {
  try {
    const file = path.join(KB_DIR, `${clientSlug}.json`);
    const raw = await fs.readFile(file, "utf8");
    const existing = JSON.parse(raw);
    return existing?.raw?.meta || null;
  } catch {
    return null;
  }
}

// ─── CLAUDE SUMMARISATION ───────────────────────────────────────────
async function summarise(client, activity, meta) {
  const prompt = `You are generating a knowledge base snapshot for a marketing agency's client success manager.

Client: ${client.name} (${client.slug})
Window: last ${WINDOW_HOURS} hours
${client.initial_context ? `\nPERMANENT CLIENT CONTEXT (doesn't change):\n${client.initial_context}\n` : ""}

META AD DATA (seeded manually from Meta Ads Manager, may be static):
${meta ? JSON.stringify(meta, null, 2) : "(no ad data seeded yet)"}

DISCORD CHANNEL ACTIVITY (last ${WINDOW_HOURS}h):
${activity.ok ? JSON.stringify(activity.messages, null, 2) : `(unavailable: ${activity.error || activity.reason})`}

Produce a JSON object with:
- "headline": one sentence summary of the client's state right now
- "ad_performance": { "spend_summary", "leads_summary", "cpl_summary", "fatigue_risks": [] } — use the Meta data if present, otherwise mark each field as "no data seeded"
- "conversation_themes": array of 3-5 short strings — what the client has been talking about in Discord
- "open_questions": array of strings — things the client has asked that may not have been answered
- "sentiment": "positive" | "neutral" | "concerned" | "frustrated"
- "talking_points": array of 3-5 strings — things CSM should proactively mention

Return ONLY valid JSON, no markdown fences.`;

  try {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.find(b => b.type === "text")?.text || "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error(`[KB-REFRESH] Summarise failed for ${client.slug}:`, err.message);
    return { headline: "KB refresh failed to summarise", error: err.message };
  }
}

// ─── BUILD KB FOR ONE CLIENT ────────────────────────────────────────
async function refreshClient(discord, client) {
  console.log(`[KB-REFRESH] ${client.slug} — starting`);

  const [activity, existingMeta] = await Promise.all([
    pullChannelActivity(discord, client.discord_channel_id),
    loadExistingMeta(client.slug),
  ]);

  const summary = await summarise(client, activity, existingMeta);

  const kb = {
    client: {
      slug: client.slug,
      name: client.name,
      discord_channel_id: client.discord_channel_id,
      meta_ad_account_id: client.meta_ad_account_id || null,
      ghl_contact_id: client.ghl_contact_id || null,
      onboarded_at: client.onboarded_at || null,
      initial_context: client.initial_context || null,
    },
    refreshed_at: new Date().toISOString(),
    window_hours: WINDOW_HOURS,
    summary,
    raw: {
      meta: existingMeta, // preserved from previous KB or manual seed — not overwritten here
      discord: activity.ok
        ? { message_count: activity.messages.length, messages: activity.messages.slice(0, 100) }
        : activity,
    },
  };

  const file = path.join(KB_DIR, `${client.slug}.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(kb, null, 2), "utf8");
  await fs.rename(tmp, file);
  console.log(`[KB-REFRESH] ${client.slug} — written`);
  return { slug: client.slug, ok: true, sentiment: summary.sentiment };
}

// ─── FULL RUN ───────────────────────────────────────────────────────
export async function runRefresh() {
  console.log(`[KB-REFRESH] Full run started ${new Date().toISOString()}`);

  let registry;
  try {
    registry = JSON.parse(await fs.readFile(REGISTRY, "utf8"));
  } catch (err) {
    console.error("[KB-REFRESH] Cannot read registry:", err.message);
    return;
  }

  const clients = registry.clients || [];
  if (clients.length === 0) {
    console.log("[KB-REFRESH] No clients in registry — skipping");
    return;
  }

  const discord = new DiscordClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  await discord.login(process.env.DISCORD_BOT_TOKEN);

  const results = [];
  for (const client of clients) {
    try {
      results.push(await refreshClient(discord, client));
    } catch (err) {
      console.error(`[KB-REFRESH] ${client.slug} fatal:`, err.message);
      results.push({ slug: client.slug, ok: false, error: err.message });
    }
  }

  await discord.destroy();

  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  await postToDiscord("KB-REFRESH", {
    content: `🧠 **CSM KB refresh complete** — ${ok}/${results.length} clients updated${failed ? `, ${failed} failed` : ""}\nNext run in 72 hours.`,
  });

  console.log(`[KB-REFRESH] Full run complete — ${ok}/${results.length} ok`);
}

// ─── SCHEDULE + INITIAL RUN ─────────────────────────────────────────
// Guarded so importing this module into DASH (for the /api/kb/refresh
// endpoint) doesn't double-schedule the cron or trigger an unwanted
// boot-time refresh. Same pattern used by FLUP/AUTO.
const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  cron.schedule("0 4 */3 * *", runRefresh);
  console.log("[KB-REFRESH] Agent started — running initial refresh");
  runRefresh().catch(err => console.error("[KB-REFRESH] Initial run failed:", err));
}
