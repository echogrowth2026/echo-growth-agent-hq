// server/csm-agent.js
// CSM — per-channel client success manager.
// Flow: keyword pre-filter → OpenAI judge → Claude KB-backed reply.
// Never replies on @mention or casual chat. /csm-misfire lets Sam flag
// bad replies so the judge learns from past misfires.
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import {
  Client as DiscordClient,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { getClientByChannelId, listClients } from "./client-data.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TRIGGERS_PATH = path.join(__dirname, "config", "csm-triggers.json");
const MISFIRES_PATH = path.join(__dirname, "config", "csm-misfires.json");

// In-memory cache of last reply per channel so /csm-misfire knows what to flag.
const lastReplyByChannel = new Map();

// ─── CONFIG LOADERS (re-read per message so edits take effect live) ──
async function loadTriggers() {
  try {
    return JSON.parse(await fs.readFile(TRIGGERS_PATH, "utf8"));
  } catch (err) {
    console.error("[CSM] Failed to load triggers:", err.message);
    return { keywords: [], ignore_if_message_contains: [], min_message_length: 8 };
  }
}

async function loadMisfires() {
  try {
    return JSON.parse(await fs.readFile(MISFIRES_PATH, "utf8"));
  } catch {
    return { misfires: [] };
  }
}

async function appendMisfire(entry) {
  const current = await loadMisfires();
  current.misfires.push(entry);
  if (current.misfires.length > 200) current.misfires = current.misfires.slice(-200);
  await fs.writeFile(MISFIRES_PATH, JSON.stringify(current, null, 2), "utf8");
}

// ─── STAGE 1: KEYWORD PRE-FILTER ──────────────────────────────────────
async function passesKeywordFilter(text) {
  const triggers = await loadTriggers();
  const lower = text.toLowerCase();

  if (text.length < triggers.min_message_length) return { pass: false, reason: "too short" };

  for (const ignore of triggers.ignore_if_message_contains) {
    if (lower.includes(ignore.toLowerCase())) {
      return { pass: false, reason: `ignore word: ${ignore}` };
    }
  }

  const matched = triggers.keywords.find(kw => lower.includes(kw.toLowerCase()));
  if (!matched) return { pass: false, reason: "no keyword match" };

  return { pass: true, matched_keyword: matched };
}

// ─── STAGE 2: OPENAI JUDGE ────────────────────────────────────────────
async function openAIJudge(message, clientName, recentMisfires) {
  const misfireExamples = recentMisfires.slice(-10).map(m =>
    `- "${m.original_message}" (Sam flagged: ${m.reason || "misfire"})`
  ).join("\n");

  const prompt = `You are a gatekeeper deciding if a Discord message is a genuine client question that the Client Success Manager should reply to.

Client: ${clientName}
Message: "${message}"

Reply ONLY if the message is:
- Asking about ad performance, leads, spend, results, or campaign status
- Expressing concern, confusion, or a problem with the service
- Asking for an update or asking "how are things going"
- A direct question that deserves a data-backed answer

Do NOT reply if:
- It's casual chat, small talk, banter, or thanks
- It's a statement or comment, not a question or concern
- It's someone on the agency team (Sam, Elliott) talking internally
- It's a greeting, reaction, or emoji response

${misfireExamples ? "PAST MISFIRES to learn from (these were flagged as replies that shouldn't have happened):\n" + misfireExamples : ""}

Return strict JSON only: {"should_reply": true|false, "confidence": 0.0-1.0, "reason": "short explanation"}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 150,
      temperature: 0.2,
    });
    return JSON.parse(res.choices[0].message.content);
  } catch (err) {
    console.error("[CSM] OpenAI judge failed:", err.message);
    // On judge failure, default to NOT replying — safer than spamming.
    return { should_reply: false, confidence: 0, reason: "judge error: " + err.message };
  }
}

// ─── STAGE 3: CLAUDE REPLY BUILDER ────────────────────────────────────
async function buildReply(clientKB, userMessage, userName) {
  const system = `You are CSM — the Client Success Manager AI for Echo Growth, a marketing agency. You are talking in the Discord channel of client "${clientKB.client.name}".

Tone: confident, direct, slightly witty British. Short and useful. No corporate fluff. Call the user by their first name when natural.

ALL factual answers must come from the KB below. If the data is not in the KB, say "I don't have that in my latest snapshot — I'll ping Sam." Do NOT invent metrics.

KB last refreshed: ${clientKB.refreshed_at}
Window: last ${clientKB.window_hours} hours

KB SUMMARY:
${JSON.stringify(clientKB.summary, null, 2)}

DATA AVAILABILITY:
- Meta ad data: ${clientKB.raw?.meta ? "seeded" : "not seeded yet"}
- Discord activity messages: ${clientKB.raw?.discord?.message_count ?? "unavailable"}

RULES:
- Never mention pausing, scaling, or changing ad spend. Read-only on ads.
- If asked about creative fatigue, cite the fatigue_risks array from the KB.
- If asked "how are things going" — lead with the headline, then add one talking_point.
- If sentiment is "concerned" or "frustrated", acknowledge it directly.
- Under 120 words unless asked for detail.`;

  try {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system,
      messages: [{ role: "user", content: `${userName}: ${userMessage}` }],
    });
    return res.content.find(b => b.type === "text")?.text || "(no reply generated)";
  } catch (err) {
    console.error("[CSM] Claude reply failed:", err.message);
    return null;
  }
}

// ─── DISCORD CLIENT ───────────────────────────────────────────────────
const discord = new DiscordClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────
discord.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const match = await getClientByChannelId(message.channel.id);
  if (!match) return;

  const text = message.content.trim();

  // Stage 1: keyword filter
  const kw = await passesKeywordFilter(text);
  if (!kw.pass) {
    console.log(`[CSM] SKIP (filter) #${message.channel.name}: ${kw.reason}`);
    return;
  }

  if (!match.kb?.summary || match.kb.summary.error) {
    console.log(`[CSM] SKIP #${message.channel.name}: no KB data for ${match.slug}`);
    return;
  }

  // Stage 2: OpenAI judge
  const { misfires } = await loadMisfires();
  const clientMisfires = misfires.filter(m => m.client_slug === match.slug);
  const judge = await openAIJudge(text, match.kb.client.name, clientMisfires);

  console.log(`[CSM] Judge #${message.channel.name} "${text.slice(0, 60)}..." → reply=${judge.should_reply} conf=${judge.confidence} (${judge.reason})`);

  if (!judge.should_reply || judge.confidence < 0.5) return; // silent fail

  // Stage 3: Claude reply
  await message.channel.sendTyping();
  const reply = await buildReply(match.kb, text, message.author.username);
  if (!reply) return;

  const sent = await message.reply(reply);

  lastReplyByChannel.set(message.channel.id, {
    client_slug: match.slug,
    channel_id: message.channel.id,
    original_message: text,
    csm_reply: reply,
    message_id: sent.id,
    timestamp: new Date().toISOString(),
  });
});

// ─── SLASH COMMAND: /csm-misfire ──────────────────────────────────────
discord.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "csm-misfire") return;

  const last = lastReplyByChannel.get(interaction.channelId);
  if (!last) {
    await interaction.reply({ content: "No recent CSM reply in this channel to flag.", ephemeral: true });
    return;
  }

  const reason = interaction.options.getString("reason") || "";
  await appendMisfire({
    ...last,
    flagged_by: interaction.user.username,
    reason,
    flagged_at: new Date().toISOString(),
  });

  lastReplyByChannel.delete(interaction.channelId);
  await interaction.reply({
    content: `✅ Flagged. CSM will learn to avoid replies like this. Reason logged: "${reason || "(none)"}"`,
    ephemeral: true,
  });
});

// ─── STARTUP + REGISTER SLASH COMMAND ─────────────────────────────────
discord.once(Events.ClientReady, async () => {
  console.log(`[CSM] Logged in as ${discord.user.tag}`);

  const clients = await listClients();
  console.log(`[CSM] Monitoring ${clients.length} client channel(s)`);
  console.log(`[CSM] Trigger mode: keyword filter → OpenAI judge → KB-backed reply`);

  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    const cmd = new SlashCommandBuilder()
      .setName("csm-misfire")
      .setDescription("Flag CSM's last reply in this channel as a misfire so it learns")
      .addStringOption(opt =>
        opt.setName("reason")
          .setDescription("Why was this a bad reply? (optional)")
          .setRequired(false)
      );
    await rest.put(
      Routes.applicationCommands(discord.user.id),
      { body: [cmd.toJSON()] }
    );
    console.log("[CSM] /csm-misfire slash command registered");
  } catch (err) {
    console.error("[CSM] Slash command registration failed:", err.message);
  }
});

discord.login(process.env.DISCORD_BOT_TOKEN);
