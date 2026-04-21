// server/csm-kb-refresh.js
// Scheduled (every 72h) knowledge-base refresh for the CSM agent. Pulls
// each registered client's Discord channel activity, preserves any
// manually-seeded Meta ad data, runs a Claude summary, and atomically
// writes server/kb/<slug>.json. Read-only against Discord; never writes.
import fs from "fs/promises";
import path from "path";
import cron from "node-cron";
import { Client as DiscordClient, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { postToDiscord } from "./discord-post.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.join(__dirname, "kb");
const REGISTRY = path.join(KB_DIR, "_clients.json");
const WINDOW_HOURS = 72;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

Produce a JSON object with EXACTLY these keys:
- "headline": one sentence summary of the client's state right now
- "themes": array of 3-5 short strings — what the client has been talking about in Discord
- "talking_points": array of 3-5 strings — things CSM should proactively mention
- "sentiment": one of "positive", "neutral", "concerned", "frustrated"

Return a valid JSON object matching this schema exactly. No markdown, no commentary.`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 1500,
      temperature: 0.3,
    });
    const text = res.choices?.[0]?.message?.content || "{}";
    return JSON.parse(text);
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
    slug: client.slug,
    updated_at: new Date().toISOString(),
    summary,
    raw: {
      meta: existingMeta, // preserved from previous KB or manual seed — not overwritten here
      discord: activity.ok
        ? { message_count: activity.messages.length, recent_messages: activity.messages.slice(0, 100) }
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
