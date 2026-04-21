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
import { fileURLToPath } from "url";
import { dirname } from "path";
import { getClientByChannelId, listClients, getRegistry } from "./client-data.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TRIGGERS_PATH = path.join(__dirname, "config", "csm-triggers.json");
const MISFIRES_PATH = path.join(__dirname, "config", "csm-misfires.json");
const KB_PATH = path.join(__dirname, "config", "csm-knowledge-base.md");

// In-memory cache of last reply per channel so /csm-misfire knows what to flag.
const lastReplyByChannel = new Map();

// Echo Growth foundational KB — loaded once at startup (see loadEchoKB below)
// and re-loaded on SIGHUP so Sam can edit without a redeploy.
let ECHO_KB = "";
async function loadEchoKB() {
  try {
    ECHO_KB = await fs.readFile(KB_PATH, "utf8");
    console.log(`[CSM] Loaded Echo Growth KB (${ECHO_KB.length} chars)`);
  } catch (err) {
    console.error("[CSM] Failed to load Echo Growth KB:", err.message);
    ECHO_KB = "";
  }
}

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
// Match a single token as a whole word, ignoring punctuation & case.
// Multi-word phrases fall back to substring (they're already whole phrases).
function containsTerm(text, term) {
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase().trim();
  if (!lowerTerm) return false;

  // Multi-word phrase: use substring match (whole phrase is already bounded)
  if (lowerTerm.includes(" ")) {
    return lowerText.includes(lowerTerm);
  }

  // Single word: regex whole-word match with word boundaries.
  // Escape any regex special chars in the term.
  const escaped = lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  return re.test(text);
}

async function passesKeywordFilter(text) {
  const triggers = await loadTriggers();

  if (text.length < triggers.min_message_length) {
    return { pass: false, reason: "too short" };
  }

  // Ignore list — now whole-word matched
  for (const ignore of triggers.ignore_if_message_contains) {
    if (containsTerm(text, ignore)) {
      return { pass: false, reason: `ignore word: ${ignore}` };
    }
  }

  // Trigger keyword — now whole-word matched
  const matched = triggers.keywords.find(kw => containsTerm(text, kw));
  if (!matched) return { pass: false, reason: "no keyword match" };

  return { pass: true, matched_keyword: matched };
}

// Self-check examples (not executed — for human review):
// containsTerm("how's the campaign performing?", "gn")        → false (fixed)
// containsTerm("how's the campaign performing?", "campaign") → true
// containsTerm("gn mate", "gn")                               → (not in ignore list anymore, so filter just won't match anything)
// containsTerm("thanks bro", "thanks")                        → true  → triggers ignore
// containsTerm("how are things with the ads?", "how are things") → true (phrase match)

// ─── STAGE 2: OPENAI JUDGE ────────────────────────────────────────────
async function openAIJudge(message, clientName, recentMisfires) {
  const misfireExamples = recentMisfires.slice(-10).map(m =>
    `- "${m.original_message}" (Sam flagged: ${m.reason || "misfire"})`
  ).join("\n");

  const systemPrompt = `You are a message classifier for a client success bot. Your job is to decide if a message deserves a reply. Be GENEROUS — if there's any chance the person is asking for information, expressing a concern, or wants an update, reply=true. Only return reply=false for obvious casual chat like 'lol', 'gm', 'nice one', emoji-only messages, or one-word acknowledgements. When in doubt, reply=true. Respond with JSON only: {"should_reply": true|false, "confidence": 0.0-1.0, "reason": "short explanation"}`;

  const userPrompt = `Client: ${clientName}
Message: "${message}"${misfireExamples ? `

PAST MISFIRES (replies that shouldn't have happened — avoid repeating):
${misfireExamples}` : ""}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
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

// ─── STAGE 3: REPLY BUILDER ──────────────────────────────────────────
async function buildReply(clientKB, clientName, userMessage, userName) {
  const system = `You are Elena, the Client Success Manager for Echo Growth. You have access to real client data in the KB below.

RULES YOU MUST FOLLOW ON EVERY REPLY:

1. ALWAYS lead with specific numbers. Never say 'specific metrics' or 'particular data' — say the actual numbers. If the KB says 58 leads at £66.80 CPL, you say '58 website schedules at £66.80 per result.'

2. NEVER ask the client what they want to know when you already have the answer. If they ask about ad performance and you have the data — just tell them. Don't say 'would you like me to share more details?' — share the details.

3. Keep it under 150 words. Be punchy, direct, data-first.

4. Use this structure for performance questions:
   - Lead with the headline number (leads, spend, CPL)
   - Flag any issues (fatigue, declining CTR, learning phase)
   - Give one clear recommendation
   - End with confidence, not a question

5. For process/general questions, answer directly from your Echo Growth knowledge base. Don't hedge.

6. If the topic involves billing, cancellation, refunds, contracts, or the client sounds frustrated/angry — say 'Let me get Sam or Elliott to speak with you directly on this' and stop. Don't try to handle it yourself.

7. Tone: professional but warm, British English, confident. You work for a premium agency charging $8k per client — sound like it.

BAD REPLY: 'If we look at the latest data, we can see specific metrics such as the performance of different ad creatives and their effectiveness.'
GOOD REPLY: '58 website schedules at £66.80 CPR over the last 28 days. Image #1 is down 28.55% in clicks and Image #3 has dropped 88.07% — both need a creative refresh. We recommend adding a 9:16 vertical Reels video which typically reduces CPR by 8%. Image Campaign is at 44/50 outcomes, nearly out of learning phase — avoid major edits until it exits.'

ECHO GROWTH KNOWLEDGE BASE:
${ECHO_KB}

CLIENT-SPECIFIC DATA:
Client: ${clientName}
Last updated: ${clientKB.updated_at || 'unknown'}
Summary: ${JSON.stringify(clientKB.summary || {})}
Meta data: ${JSON.stringify(clientKB.raw?.meta || {})}
Recent Discord themes: ${JSON.stringify(clientKB.raw?.discord || {})}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${userName}: ${userMessage}` },
      ],
      max_tokens: 400,
      temperature: 0.5,
    });
    return res.choices?.[0]?.message?.content || "(no reply generated)";
  } catch (err) {
    console.error("[CSM] Reply failed:", err.message);
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
    console.log(`[CSM] SKIP (no-kb) #${message.channel.name} slug=${match.slug} — waiting on KB refresh`);
    return;
  }

  // Stage 2: OpenAI judge
  const clientName = match.registry?.name || match.kb?.slug || match.slug;
  const { misfires } = await loadMisfires();
  const clientMisfires = misfires.filter(m => m.client_slug === match.slug);
  const judge = await openAIJudge(text, clientName, clientMisfires);

  console.log(`[CSM] Judge #${message.channel.name} "${text.slice(0, 60)}..." → reply=${judge.should_reply} conf=${judge.confidence} (${judge.reason})`);

  if (!judge.should_reply || judge.confidence < 0.5) return; // silent fail

  // Stage 3: reply
  await message.channel.sendTyping();
  const reply = await buildReply(match.kb, clientName, text, message.author.username);
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
  await loadEchoKB();
  console.log(`[CSM] Logged in as ${discord.user.tag}`);

  const registry = await getRegistry();
  const seeded = await listClients();
  console.log(`[CSM] Monitoring ${registry.clients?.length || 0} client channel(s) · ${seeded.length} with KB seeded`);
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

// Live reload of the Echo Growth KB without restart: `kill -SIGHUP <pid>`.
process.on("SIGHUP", () => {
  console.log("[CSM] SIGHUP received — reloading Echo Growth KB");
  loadEchoKB();
});

discord.login(process.env.DISCORD_BOT_TOKEN);
