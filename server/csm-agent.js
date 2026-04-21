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

// ─── STAGE 3: REPLY BUILDER ──────────────────────────────────────────
async function buildReply(clientKB, clientName, userMessage, userName) {
  const system = `${ECHO_KB}

═══════════════════════════════════════
CURRENT CLIENT CONTEXT
═══════════════════════════════════════

You are currently speaking with someone from the Discord channel of client "${clientName}".

KB last updated: ${clientKB.updated_at || "unknown"}

CLIENT KB SUMMARY:
${JSON.stringify(clientKB.summary, null, 2)}

DATA AVAILABILITY:
- Meta ad data: ${clientKB.raw?.meta ? "available" : "unavailable"}
- Discord activity messages: ${clientKB.raw?.discord?.message_count ?? "unavailable"}

═══════════════════════════════════════
REPLY RULES (HARD)
═══════════════════════════════════════

1. ESCALATION TRIGGERS: If the user's message mentions refund, cancel, cancellation, billing, payment problem, invoice dispute, contract, legal, or sounds frustrated/angry — reply ONLY with a brief acknowledgement and "Let me escalate this to Sam and Elliott so they can address it directly." Do NOT try to resolve the concern yourself. Do not quote policy. Just escalate.

2. DATA RULES: Metric answers (spend, leads, CPL, CTR) MUST come from the CLIENT KB SUMMARY above. If a metric isn't in the KB, say "I don't have that in my latest snapshot — I'll check with the team." Never invent numbers.

3. AD SPEND: You are READ-ONLY on ads. Never say you will pause, scale, or change budget. If asked, say Sam or Elliott will review and action.

4. TONE: Professional but warm. British English (optimise, colour, organise). Under 150 words. Call the user by their first name when natural. No corporate fluff. Slightly witty is fine, over-familiar is not.

5. LEARNING PHASE: If the client is in weeks 1-2 and concerned about performance, reassure with the "Meta learning phase" explanation from the foundational KB.

6. IMPORTANT: Always cite specific numbers and data from the client's KB when answering. Don't be vague. If you have CPL, spend, lead count, creative fatigue percentages — quote them directly. For example say "Image #1 is down 28.55% in clicks" not "we should monitor performance". Be specific, be data-driven, be direct. You have the data — use it.`;

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
