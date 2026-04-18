import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import dotenv from "dotenv";
import cron from "node-cron";

dotenv.config();

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DASH_API = process.env.DASH_API || "https://echo-growth-agent-hq-production.up.railway.app";
const GUILD_ID = "1361808743783862536";
const TEST_CHANNEL_ID = "1483839262594957472";

const MONITORED_CHANNELS = new Set([TEST_CHANNEL_ID]);

let SAM_USER_ID = null;

// ─── KNOWLEDGE BASE ────────────────────────────────────────────────
const KNOWLEDGE_BASE = `You are CSM Agent, the Client Success Manager bot for Echo Growth, a marketing agency that builds GoHighLevel (GHL) systems for clients.

ABOUT ECHO GROWTH:
- We build automated sales and marketing systems using GoHighLevel
- Services include: CRM setup, funnel building, automation workflows, ad management, appointment booking systems
- Founders: Sam and Elliott
- We serve UK-based businesses
- Ticket price is $6k USD

COMMON CLIENT QUESTIONS & ANSWERS:
- "When will my system be ready?" → Typical build time is 5-7 business days from onboarding. If you need an exact update, I'll escalate to the team.
- "How do I log into GHL?" → You'll receive login credentials via email. Check your inbox/spam. If not found, I'll get the team to resend.
- "Can you add X feature?" → I'll note your request and pass it to the build team. Custom features may require a scoping call.
- "My automation isn't working" → Can you describe what's happening? I'll flag this to the ops team for immediate review.
- "When is my next call?" → Let me check the calendar. I'll get back to you shortly.

TONE & STYLE:
- Professional but friendly — like a helpful account manager
- Use "we" when referring to Echo Growth
- Be concise — clients want quick answers, keep replies under 150 words
- If you don't know something, say "Let me check with the team and get back to you" and flag it for escalation
- Never make promises about timelines you can't verify
- Never fabricate information
- Use British English

ESCALATION RULES:
- If a client seems frustrated or angry → escalate immediately
- If a question involves billing, refunds, or contracts → escalate
- If you're not confident in the answer → escalate
- Technical issues with GHL → escalate to ops team
- When escalating, tag Sam and provide full context`;

// ─── OPENAI API HELPER ──────────────────────────────────────────────
async function askAI(message, channelContext = "") {
  if (!OPENAI_API_KEY) {
    return "I'm currently being set up — I'll be fully operational soon! Let me flag this to the team.";
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 500,
        messages: [
          { role: "system", content: KNOWLEDGE_BASE + (channelContext ? `\n\nRECENT CHANNEL CONTEXT:\n${channelContext}` : "") },
          { role: "user", content: message },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[CSM] OpenAI API error:", res.status, text);
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("[CSM] OpenAI API failed:", e.message);
    return null;
  }
}

// ─── FETCH DASH DATA ────────────────────────────────────────────────
async function getDashData() {
  try {
    const res = await fetch(`${DASH_API}/api/dash`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("[CSM] DASH fetch failed:", e.message);
    return null;
  }
}

// ─── CLIENT LOOKUP VIA DASH ─────────────────────────────────────────
async function lookupClient(name) {
  try {
    const res = await fetch(`${DASH_API}/api/dash/lookup/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("[CSM] Client lookup failed:", e.message);
    return null;
  }
}

// ─── SHOULD RESPOND ─────────────────────────────────────────────────
function shouldRespond(message) {
  if (message.mentions.has(message.client.user)) return true;
  if (message.author.bot) return false;
  if (message.content.trim().length < 3) return false;
  if (MONITORED_CHANNELS.has(message.channel.id) && message.content.includes("?")) return true;
  if (message.content.toLowerCase().includes("csm")) return true;
  return false;
}

// ─── CHECK IF ESCALATION NEEDED ─────────────────────────────────────
function needsEscalation(message) {
  const lower = message.toLowerCase();
  const triggers = [
    "refund", "cancel", "billing", "payment", "invoice",
    "angry", "furious", "disappointed", "terrible", "worst",
    "urgent", "asap", "emergency",
    "not working", "broken", "down", "error",
    "speak to someone", "talk to a human", "manager",
  ];
  return triggers.some(t => lower.includes(t));
}

// ─── DETECT CLIENT LOOKUP REQUEST ───────────────────────────────────
function extractLookupName(message) {
  const patterns = [
    /where is (.+?)(?:\s+at|\s+in|\?|$)/i,
    /look up (.+?)(?:\?|$)/i,
    /find (.+?)(?:\?|$)/i,
    /status (?:of|for) (.+?)(?:\?|$)/i,
    /check on (.+?)(?:\?|$)/i,
    /how is (.+?) doing/i,
    /what stage is (.+?)(?:\s+at|\s+in|\?|$)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

// ─── DISCORD CLIENT ─────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`[CSM Agent] Logged in as ${client.user.tag}`);
  console.log(`[CSM Agent] Monitoring ${MONITORED_CHANNELS.size} channel(s)`);
  console.log(`[CSM Agent] Guild: ${GUILD_ID}`);
  console.log(`[CSM Agent] AI: OpenAI ${OPENAI_API_KEY ? "configured" : "NOT SET"}`);

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    SAM_USER_ID = guild.ownerId;
    console.log(`[CSM Agent] Escalation target: ${SAM_USER_ID}`);
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.id === client.user.id) return;
  if (!shouldRespond(message)) return;

  console.log(`[CSM] Message from ${message.author.username}: ${message.content.substring(0, 100)}`);
  await message.channel.sendTyping();

  // ─── CHECK FOR CLIENT LOOKUP ────────────────────────────────────
  const lookupName = extractLookupName(message.content);
  if (lookupName) {
    console.log(`[CSM] Client lookup: "${lookupName}"`);
    const result = await lookupClient(lookupName);

    if (result && result.found) {
      const contact = result.contacts[0];
      const oppLines = (contact.opportunities || []).map(o =>
        `› **${o.pipeline}** — ${o.stage} (${o.status})`
      ).join("\n") || "No pipeline data";

      const embed = new EmbedBuilder()
        .setColor(0x34D399)
        .setTitle(`📋 ${contact.name}`)
        .addFields(
          { name: "Pipeline Status", value: oppLines, inline: false },
          { name: "Email", value: contact.email || "N/A", inline: true },
          { name: "Phone", value: contact.phone || "N/A", inline: true },
          { name: "Source", value: contact.source || "N/A", inline: true },
          { name: "Tags", value: (contact.tags || []).join(", ") || "None", inline: false },
          { name: "Added", value: contact.dateAdded ? new Date(contact.dateAdded).toLocaleDateString("en-GB") : "N/A", inline: true },
          { name: "Last Activity", value: contact.lastActivity ? new Date(contact.lastActivity).toLocaleDateString("en-GB") : "N/A", inline: true },
        )
        .setFooter({ text: "CSM Agent · Client Lookup" })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      console.log(`[CSM] Lookup result sent for "${lookupName}"`);
      return;
    } else {
      const embed = new EmbedBuilder()
        .setColor(0xEF4444)
        .setDescription(`No contact found matching "${lookupName}". Try using their full name.`)
        .setFooter({ text: "CSM Agent · Client Lookup" });
      await message.reply({ embeds: [embed] });
      return;
    }
  }

  // ─── REGULAR AI RESPONSE ────────────────────────────────────────
  let channelContext = "";
  try {
    const recent = await message.channel.messages.fetch({ limit: 6 });
    channelContext = recent
      .reverse()
      .filter(m => m.id !== message.id)
      .map(m => `${m.author.username}: ${m.content}`)
      .join("\n");
  } catch (e) { /* ignore */ }

  const response = await askAI(message.content, channelContext);

  if (!response) {
    await message.reply("I'm having a technical issue right now. Let me flag this to the team — someone will get back to you shortly.");
    return;
  }

  const escalate = needsEscalation(message.content);

  const embed = new EmbedBuilder()
    .setColor(escalate ? 0xFBBF24 : 0x5865F2)
    .setDescription(response)
    .setFooter({ text: escalate ? "CSM Agent · Escalating to team" : "CSM Agent · Echo Growth" })
    .setTimestamp();

  await message.reply({ embeds: [embed] });

  if (escalate && SAM_USER_ID) {
    const escalationEmbed = new EmbedBuilder()
      .setColor(0xEF4444)
      .setTitle("🚨 CSM Escalation")
      .setDescription(`**Channel:** <#${message.channel.id}>\n**From:** ${message.author.username}\n**Message:** ${message.content}\n\n**CSM Response:** ${response.substring(0, 200)}...`)
      .setFooter({ text: "Needs human attention" })
      .setTimestamp();

    try {
      const sam = await client.users.fetch(SAM_USER_ID);
      await sam.send({ embeds: [escalationEmbed] });
      console.log(`[CSM] Escalation sent to Sam`);
    } catch (e) { console.error("[CSM] Escalation DM failed:", e.message); }
  }

  console.log(`[CSM] Replied in ${message.channel.name} (escalated: ${escalate})`);
});

// ─── MONDAY CHECK-INS ──────────────────────────────────────────────
cron.schedule("0 8 * * 1", async () => {
  console.log("[CSM] Monday 9am check-in...");
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const dashData = await getDashData();
  const leadsInfo = dashData ? `We had **${dashData.leads?.today || 0}** new leads come in recently.` : "";

  for (const channelId of MONITORED_CHANNELS) {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel) continue;

      const embed = new EmbedBuilder()
        .setColor(0x34D399)
        .setTitle("👋 Monday Check-in")
        .setDescription(`Good morning! Just checking in to make sure everything is running smoothly.\n\n${leadsInfo}\n\nAnything you need from us this week? Drop a message here and I'll make sure the team sees it.`)
        .setFooter({ text: "CSM Agent · Weekly Check-in" })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      console.log(`[CSM] Check-in sent to ${channel.name}`);
    } catch (e) { console.error(`[CSM] Check-in failed:`, e.message); }
  }
});

// ─── START ───────────────────────────────────────────────────────────
if (!DISCORD_BOT_TOKEN) {
  console.error("[CSM] No DISCORD_BOT_TOKEN — cannot start");
  process.exit(1);
}

client.login(DISCORD_BOT_TOKEN);
console.log("[CSM Agent] Starting...");
