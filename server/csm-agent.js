import { Client, GatewayIntentBits, EmbedBuilder, ChannelType } from "discord.js";
import dotenv from "dotenv";
import cron from "node-cron";
import { logActivity } from "./activity-log.js";

dotenv.config();

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const DASH_API = process.env.DASH_API || "https://echo-growth-agent-hq-production.up.railway.app";
const GUILD_ID = process.env.CSM_GUILD_ID || "1361808743783862536";
const TEST_CHANNEL_ID = "1483839262594957472";

// Channels where CSM actively replies (AI triage + responses).
const MONITORED_CHANNELS = new Set([TEST_CHANNEL_ID]);

// Passive counter channels — no replies, only counts are incremented.
// Set these to Discord channel IDs via env to activate.
const CHANNEL_NEW_LEADS = process.env.CHANNEL_NEW_LEADS || "";
const CHANNEL_NEW_CALLS = process.env.CHANNEL_NEW_CALLS || "";
const CHANNEL_NEW_PAYMENTS = process.env.CHANNEL_NEW_PAYMENTS || "";
const CHANNEL_CALL_REVIEWS = process.env.CHANNEL_CALL_REVIEWS || ""; // where review embeds get posted
const CHANNEL_ONBOARDING_CATEGORY = process.env.CHANNEL_ONBOARDING_CATEGORY || ""; // parent category for auto-created client channels

const COUNTER_CHANNELS = new Map([
  [CHANNEL_NEW_LEADS, "leads"],
  [CHANNEL_NEW_CALLS, "calls"],
  [CHANNEL_NEW_PAYMENTS, "payments"],
].filter(([id]) => id));

// Pipeline stage name (case-insensitive substring) that triggers auto-channel creation.
const NEW_CLIENT_STAGE_MATCH = (process.env.NEW_CLIENT_STAGE_MATCH || "onboarding").toLowerCase();

let SAM_USER_ID = null;

// Tracks opportunities we've already processed for channel auto-creation
// so we don't create duplicates. Keyed by opportunityId → last seen stage.
const seenOpportunityStages = new Map();

// ─── DASH HELPERS ───────────────────────────────────────────────────
async function postDiscordStat(type, amount = 1) {
  try {
    await fetch(`${DASH_API}/api/dash/discord-stats/increment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, amount }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) { /* swallow */ }
}

// Parse GBP/USD amounts from a payment notification message.
// Handles "£6,000", "$6k", "6000 GBP", etc. Returns first amount found or 0.
function parsePaymentAmount(text) {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, "");
  const patterns = [
    /[£$€]\s*([\d.]+)\s*([kKmM])?/,
    /([\d.]+)\s*([kKmM])\s*(?:GBP|USD|EUR)?/i,
    /([\d.]+)\s*(?:GBP|USD|EUR)/i,
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m) {
      let n = parseFloat(m[1]);
      const suffix = (m[2] || "").toLowerCase();
      if (suffix === "k") n *= 1000;
      else if (suffix === "m") n *= 1_000_000;
      if (!isNaN(n) && n > 0) return Math.round(n);
    }
  }
  return 0;
}

// ─── GHL v2 API HELPER ─────────────────────────────────────────────
async function ghlFetch(endpoint, options = {}) {
  const method = options.method || "GET";
  const body = options.body || null;
  const res = await fetch(`https://services.leadconnectorhq.com/${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, "Content-Type": "application/json", Version: "2021-07-28" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`GHL ${res.status} ${endpoint} — ${t}`); }
  return res.json();
}

// ─── KNOWLEDGE BASE ────────────────────────────────────────────────
const KNOWLEDGE_BASE = `You are CSM Agent, the Client Success Manager bot for Echo Growth. You handle client questions, provide status updates, and escalate when needed. You speak in British English, are professional but friendly, and keep replies concise (under 150 words unless a detailed answer is genuinely needed).

=== ABOUT ECHO GROWTH ===
Echo Growth is a UK-based marketing agency that builds automated sales and marketing systems using GoHighLevel (GHL). We create predictable, scalable client acquisition systems. The goal is to build a machine where a client can invest £1 and know what comes back.

Founders: Sam and Elliott (Co-Founders). Sam handles AI, system builds, strategy, and most client responses. Elliott handles strategy, offer positioning, and is usually the primary client contact during onboarding.
Other team: Ollie (execution, coordination, onboarding), Rachel (Account Manager), Kieran (content/support).
Ticket price: $6k USD.

=== THE 3-PHASE PROCESS ===
PHASE 1: ONBOARDING (Days 1-3) — Onboarding call, agreement signing, strategy doc review, offer development. Project doesn't proceed until offer is approved.
PHASE 2: PRODUCTION (Days 3-7, max 15 business days) — Strategy call, ad scripts delivered (24-48hrs), client films videos (72hrs), we build everything: ads, funnel, automations, booking system, training.
PHASE 3: GO LIVE (60-75 day campaign) — Week 1-2: Learning phase, inconsistent results normal. Week 2-4: Should hit target KPIs. Week 4-6: Consistent performance. Week 6-8: Peak performance.

=== REVISIONS ===
Normal and expected. Minor edits: 24-48hrs. Major changes: 3-5 business days. No additional fees. Triggered when underperforming vs KPIs for 7-10 days.

=== KEY METRICS ===
Echo manages: CTR, CPL, CPBC, ad spend, campaign health, creative, targeting.
Client controls: Show Rate (target 80%+) and Close Rate (target 35-50%).

=== EXPECTATIONS BY MONTH ===
Month 1-2: Foundation — testing, expect variability.
Month 3-4: Optimisation — winning elements identified, costs stabilise.
Month 5+: Scale — predictable returns.

=== SHOW RATE TACTICS ===
1. Pre-Call Trust Video (2-3 min iPhone video, +15-25% show rate)
2. Multi-Channel Reminders (SMS + email + voicemail at booking, 24hrs, morning of, 2hrs, 1hr before)
3. Speed to Lead (max 48hr booking window, setter calls within 5 mins)
4. Instant Value Delivery (send resource immediately after booking)
5. Same-Day Blitz (morning text, 2hr email, 1hr SMS, 15min text)
6. No-Show Recovery (text within 5 mins, email within 1hr, case study Day 2, voice note Day 3, final Day 5)
7. Booking Page Optimisation (testimonials, value prop, reduce form fields)

=== CLOSE RATE TACTICS ===
1. Discovery-First (70/30 rule, prospect talks 60-70%)
2. Pre-Call Intelligence (5-10 min research before every call)
3. Objection Prevention (address objections before they come up)
4. Clear Next Step (never end without scheduled action)
5. Price Anchoring (quantify problem cost first, then reveal price)
6. 90-Day Follow-Up Cadence (60% of deals close after 5th follow-up)
7. Call Recording Review (2 calls/week, track talk-to-listen ratio)
8. Assumptive Close (progressive yes's throughout the call)

=== CLIENT RESPONSIBILITIES ===
Respond to leads within 5 minutes. Follow up no-shows within 24hrs. Keep ad account funded. Attend check-ins. Provide lead quality feedback. Review dashboard weekly.

=== SUPPORT ===
Discord is the main channel. Responses within 24hrs (excl weekends). Unlimited support: call reviews, scripts, objection handling, troubleshooting, strategy revisions. Sam handles AI/system questions.

=== COMMON QUESTIONS ===
"When will my system be ready?" → 7-10 business days from onboarding.
"My ads aren't performing" → First 1-2 weeks is learning phase, completely normal. If no improvement by weeks 2-4, we do a full review and revise at no cost.
"What should my ad spend be?" → Your strategist will advise during onboarding based on your goals and market.
"I want to cancel" → [ESCALATE TO SAM IMMEDIATELY]

=== ESCALATION RULES ===
ALWAYS escalate when: refund, cancel, billing, payment, contract, legal, frustrated/angry language, pricing questions, technical GHL issues you can't answer, or you're not confident. Provide full context.`;

// ─── OPENAI HELPER ──────────────────────────────────────────────────
async function callOpenAI(systemPrompt, userMessage, maxTokens = 500) {
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
    if (!res.ok) { console.error("[CSM] OpenAI error:", res.status, await res.text()); return null; }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) { console.error("[CSM] OpenAI failed:", e.message); return null; }
}

// ─── TRIAGE: SHOULD WE RESPOND? ─────────────────────────────────────
async function shouldRespondAI(message, channelContext) {
  const triagePrompt = `You are a message triage system for a client success bot in a Discord server. Your job is to decide if a message needs a response from the CSM bot.

Reply with EXACTLY one word:
- "RESPOND" if the message is: a question, a concern, a complaint, a request for help, a request for information, a status update request, asking about timelines, expressing frustration, asking about performance, mentioning ads/campaigns/leads/bookings, or anything a CSM should address.
- "SKIP" if the message is: casual chat, greetings without a question (just "hey", "morning"), banter between team members, emojis only, reactions, one-word acknowledgements ("ok", "sure", "nice", "lol", "thanks"), internal team discussion that doesn't need bot input, or someone clearly talking to another human (not the bot).

Recent channel context:
${channelContext}

Only reply RESPOND or SKIP. Nothing else.`;

  const result = await callOpenAI(triagePrompt, message, 10);
  return result?.trim()?.toUpperCase() === "RESPOND";
}

// ─── CLIENT LOOKUP ──────────────────────────────────────────────────
async function lookupClient(name) {
  try {
    const res = await fetch(`${DASH_API}/api/dash/lookup/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

// ─── GET DASH DATA ──────────────────────────────────────────────────
async function getDashData() {
  try {
    const res = await fetch(`${DASH_API}/api/dash`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

// ─── BUILD CLIENT CONTEXT FOR AI ────────────────────────────────────
async function getClientContext(username) {
  // Try to find the client in GHL by their Discord display name
  const result = await lookupClient(username);
  if (!result || !result.found) return "";

  const contact = result.contacts[0];
  const oppLines = (contact.opportunities || []).map(o =>
    `Pipeline: ${o.pipeline}, Stage: ${o.stage}, Status: ${o.status}`
  ).join("; ");

  return `\n\n=== THIS CLIENT'S LIVE DATA FROM GHL ===
Name: ${contact.name}
Email: ${contact.email || "N/A"}
Pipeline Status: ${oppLines || "No pipeline data"}
Tags: ${(contact.tags || []).join(", ") || "None"}
Date Added: ${contact.dateAdded || "N/A"}
Last Activity: ${contact.lastActivity || "N/A"}
Source: ${contact.source || "N/A"}

Use this data naturally in your response when relevant. Reference their specific stage, metrics, or status. Don't dump all the data — weave in what's relevant to their question.`;
}

// ─── BUILD OVERALL METRICS CONTEXT ──────────────────────────────────
async function getMetricsContext() {
  const dash = await getDashData();
  if (!dash) return "";

  let pipelineInfo = "";
  if (dash.opportunities?.pipelines) {
    for (const p of dash.opportunities.pipelines) {
      const activeStages = Object.entries(p.stages || {}).filter(([_, c]) => c > 0);
      if (activeStages.length > 0) {
        pipelineInfo += `${p.name}: ${activeStages.map(([n, c]) => `${n}(${c})`).join(", ")}. `;
      }
    }
  }

  return `\n\n=== CURRENT LIVE METRICS (from DASH agent) ===
Total Leads: ${dash.leads?.total || 0} (${dash.leads?.today || 0} new today)
Open Opportunities: ${dash.opportunities?.open || 0}
Bookings Today: ${dash.bookings?.total || 0}, Show Rate: ${dash.bookings?.showRate || 0}%
Conversations: ${dash.conversations?.total || 0} (${dash.conversations?.unread || 0} unread)
Pipeline Breakdown: ${pipelineInfo || "No data"}

Reference these metrics naturally when relevant — e.g. if they ask about performance, mention their specific numbers.`;
}

// ─── CHECK ESCALATION ───────────────────────────────────────────────
function needsEscalation(message) {
  const lower = message.toLowerCase();
  const triggers = [
    "refund", "cancel", "billing", "payment", "invoice", "contract", "legal",
    "angry", "furious", "disappointed", "terrible", "worst", "scam", "rip off",
    "urgent", "asap", "emergency",
    "speak to someone", "talk to a human", "manager", "founder",
  ];
  return triggers.some(t => lower.includes(t));
}

// ─── DETECT CLIENT LOOKUP ───────────────────────────────────────────
function extractLookupName(message) {
  const patterns = [
    /where is (.+?)(?:\s+at|\s+in|\?|$)/i,
    /look up (.+?)(?:\?|$)/i,
    /find (.+?)(?:\?|$)/i,
    /status (?:of|for) (.+?)(?:\?|$)/i,
    /check on (.+?)(?:\?|$)/i,
    /how is (.+?) doing/i,
    /what stage is (.+?)(?:\s+at|\s+in|\?|$)/i,
    /update on (.+?)(?:\?|$)/i,
    /progress (?:of|for|on) (.+?)(?:\?|$)/i,
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
  console.log(`[CSM Agent] AI: OpenAI ${OPENAI_API_KEY ? "✓" : "✗"}`);
  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) { SAM_USER_ID = guild.ownerId; }
});

// ─── CALL REVIEW ────────────────────────────────────────────────────
// Detects recording links (file extensions or common call-recorder hosts).
const RECORDING_URL_RE = /\bhttps?:\/\/\S+\.(mp3|mp4|wav|m4a|webm|ogg)\b|\b(gong\.io|fireflies\.ai|fathom\.video|zoom\.us\/rec|loom\.com|drive\.google\.com|otter\.ai|grain\.co|riverside\.fm)\S*/i;

function gradeFor(overall) {
  if (overall >= 8.5) return "A";
  if (overall >= 7) return "B";
  if (overall >= 5) return "C";
  return "D";
}

async function runCallReview(message, recordingUrl) {
  // If the user pasted a transcript alongside the URL, use it. Otherwise
  // ask for a transcript in-thread and score the framing.
  const contentWithoutUrl = message.content.replace(recordingUrl || "", "").trim();
  const hasTranscript = contentWithoutUrl.length > 200;

  const prompt = `You are a sales call reviewer for Echo Growth (UK marketing agency, $6k ticket, GHL acquisition systems).

Grade the call against Echo Growth's sales playbook. Return STRICT JSON (no markdown fences):
{
  "discovery_score": <1-10>,
  "objection_score": <1-10>,
  "close_score": <1-10>,
  "energy_score": <1-10>,
  "talk_listen_ratio": "<estimated rep/prospect split, e.g. '40/60'>",
  "overall_score": <1-10 decimal OK>,
  "headline": "<one-line verdict>",
  "coaching_points": ["3 specific, actionable fixes"],
  "one_thing_done_well": "<single biggest strength>",
  "transcript_needed": <true if you couldn't score properly without more data>
}

Scoring rubric:
- discovery: did they use the 70/30 rule (prospect talks 60-70%)? Deep questions? Pre-call intel visible?
- objection: were objections prevented or handled cleanly, or fumbled?
- close: clear next step locked in? Assumptive close pattern? Price anchored?
- energy: rapport, pacing, confidence
If no transcript is provided, set transcript_needed=true and score conservatively from framing.`;

  const ctx = `Caller: ${message.member?.displayName || message.author.username}
Channel: #${message.channel.name}
Recording URL: ${recordingUrl || "none"}
Transcript/notes included: ${hasTranscript ? "YES" : "NO"}

${hasTranscript ? `Transcript/notes:\n${contentWithoutUrl}` : "(no transcript — score conservatively and set transcript_needed=true)"}`;

  const raw = await callOpenAI(prompt, ctx, 900);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    parsed.overall_score = parsed.overall_score ?? Math.round(((parsed.discovery_score + parsed.objection_score + parsed.close_score + parsed.energy_score) / 4) * 10) / 10;
    parsed.grade = gradeFor(parsed.overall_score);
    return parsed;
  } catch {
    return { overall_score: 0, grade: "D", headline: raw.substring(0, 120), coaching_points: [], one_thing_done_well: "", transcript_needed: true };
  }
}

async function postCallReview(channel, author, review, recordingUrl) {
  const score = review.overall_score ?? 0;
  const color = score >= 7 ? 0x34D399 : score >= 5 ? 0xFBBF24 : 0xEF4444;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`📞 Call Review — ${score}/10 · Grade ${review.grade || "—"}`)
    .setDescription(review.headline || "Analysis complete");

  embed.addFields(
    { name: "Caller", value: author, inline: true },
    { name: "Recording", value: recordingUrl?.substring(0, 200) || "—", inline: true },
    { name: "Talk/Listen", value: review.talk_listen_ratio || "—", inline: true },
    { name: "🔍 Discovery", value: `${review.discovery_score ?? "—"}/10`, inline: true },
    { name: "🛡 Objections", value: `${review.objection_score ?? "—"}/10`, inline: true },
    { name: "🤝 Close", value: `${review.close_score ?? "—"}/10`, inline: true },
    { name: "⚡ Energy", value: `${review.energy_score ?? "—"}/10`, inline: true },
  );

  if (review.one_thing_done_well) {
    embed.addFields({ name: "✅ Did Well", value: review.one_thing_done_well.substring(0, 1024), inline: false });
  }
  if (review.coaching_points?.length) {
    embed.addFields({
      name: "🎯 Coaching Points",
      value: review.coaching_points.map((p, i) => `${i + 1}. ${p}`).join("\n").substring(0, 1024),
      inline: false,
    });
  }
  if (review.transcript_needed) {
    embed.addFields({ name: "📝 Needs Transcript", value: "Paste the call transcript in a reply for a deeper review — these scores are based on framing only.", inline: false });
  }

  embed.setFooter({ text: "CSM Agent · Call Review vs Echo Growth playbook" }).setTimestamp();
  await channel.send({ embeds: [embed] });
}

client.on("messageCreate", async (message) => {
  if (message.author.id === client.user.id) return;
  if (message.author.bot) return;
  if (message.content.trim().length < 2) return;

  // ─── PASSIVE COUNTER CHANNELS ─────────────────────────────────────
  // Count messages in #new-leads / #new-calls / #new-payments, no reply.
  if (COUNTER_CHANNELS.has(message.channel.id)) {
    const type = COUNTER_CHANNELS.get(message.channel.id);
    const amount = type === "payments" ? parsePaymentAmount(message.content) : 1;
    await postDiscordStat(type, amount);
    await logActivity("CSM", `counted ${type}`, type === "payments" ? `£${amount.toLocaleString()} from ${message.author.username}` : `from ${message.author.username}`);
    return;
  }

  // ─── CALL RECORDING REVIEW ────────────────────────────────────────
  const recordingMatch = message.content.match(RECORDING_URL_RE);
  if (recordingMatch && MONITORED_CHANNELS.has(message.channel.id)) {
    const url = recordingMatch[0];
    await message.react("👂").catch(() => {});
    await message.reply(`Got the recording — running it against the playbook now. Posting the review in <#${CHANNEL_CALL_REVIEWS || message.channel.id}> shortly.`);
    await message.channel.sendTyping();
    const review = await runCallReview(message, url);
    if (review) {
      const targetChannel = CHANNEL_CALL_REVIEWS
        ? (await client.channels.fetch(CHANNEL_CALL_REVIEWS).catch(() => message.channel)) || message.channel
        : message.channel;
      await postCallReview(targetChannel, message.member?.displayName || message.author.username, review, url);
      await logActivity("CSM", "call reviewed", `${review.grade || "?"} grade (${review.overall_score}/10) for ${message.author.username}`);
    }
    return;
  }

  if (!MONITORED_CHANNELS.has(message.channel.id)) return;

  const isMentioned = message.mentions.has(client.user);

  // Get channel context
  let channelContext = "";
  try {
    const recent = await message.channel.messages.fetch({ limit: 6 });
    channelContext = recent.reverse().filter(m => m.id !== message.id)
      .map(m => `${m.author.username}: ${m.content}`).join("\n");
  } catch (e) { /* ignore */ }

  // If not directly mentioned, use AI triage to decide
  if (!isMentioned) {
    const shouldReply = await shouldRespondAI(message.content, channelContext);
    if (!shouldReply) {
      console.log(`[CSM] Skipped (casual): ${message.content.substring(0, 50)}`);
      return;
    }
  }

  console.log(`[CSM] Responding to ${message.author.username}: ${message.content.substring(0, 80)}`);
  await message.channel.sendTyping();

  // ─── CLIENT LOOKUP (explicit request) ───────────────────────────
  const lookupName = extractLookupName(message.content);
  if (lookupName) {
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
        .setFooter({ text: "CSM Agent · Client Lookup via GHL" })
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      return;
    } else {
      const embed = new EmbedBuilder().setColor(0xEF4444)
        .setDescription(`No contact found matching "${lookupName}". Try their full name.`)
        .setFooter({ text: "CSM Agent" });
      await message.reply({ embeds: [embed] });
      return;
    }
  }

  // ─── FETCH CLIENT + METRICS CONTEXT ─────────────────────────────
  const displayName = message.member?.displayName || message.author.username;
  const [clientContext, metricsContext] = await Promise.all([
    getClientContext(displayName),
    getMetricsContext(),
  ]);

  const fullPrompt = KNOWLEDGE_BASE + clientContext + metricsContext +
    `\n\nRECENT CHANNEL CONTEXT:\n${channelContext}` +
    `\n\nThe person messaging is: ${displayName}. Address them naturally. If you have their live data, reference it when relevant — don't dump it all.`;

  const response = await callOpenAI(fullPrompt, message.content);

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
      .setDescription(`**Channel:** <#${message.channel.id}>\n**From:** ${displayName}\n**Message:** ${message.content}\n\n**CSM Response:** ${response.substring(0, 200)}...`)
      .setFooter({ text: "Needs human attention" })
      .setTimestamp();
    try {
      const sam = await client.users.fetch(SAM_USER_ID);
      await sam.send({ embeds: [escalationEmbed] });
    } catch (e) { console.error("[CSM] Escalation DM failed:", e.message); }
  }

  await logActivity("CSM", escalate ? "replied + escalated" : "replied", `to ${displayName}`);
  console.log(`[CSM] Replied (escalated: ${escalate})`);
});

// ─── AUTO-CREATE CLIENT CHANNELS ────────────────────────────────────
function slugify(name) {
  return (name || "client").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 60);
}

async function scanForNewClientChannels() {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  try {
    const data = await ghlFetch(`opportunities/search?location_id=${GHL_LOCATION_ID}`, {
      method: "POST", body: { locationId: GHL_LOCATION_ID, status: "won", limit: 50 },
    });

    const opps = data.opportunities || [];
    for (const opp of opps) {
      const stageName = (opp.pipelineStageName || "").toLowerCase();
      const prev = seenOpportunityStages.get(opp.id);
      seenOpportunityStages.set(opp.id, stageName);

      // Only fire on transitions INTO a stage matching NEW_CLIENT_STAGE_MATCH
      if (!stageName.includes(NEW_CLIENT_STAGE_MATCH)) continue;
      if (prev === stageName) continue; // already in this stage, don't re-create

      const clientName = opp.contact?.name || opp.name || "client";
      const channelName = `client-${slugify(clientName)}`;

      // Skip if channel already exists
      const existing = guild.channels.cache.find(c => c.name === channelName);
      if (existing) continue;

      try {
        const created = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: CHANNEL_ONBOARDING_CATEGORY || undefined,
          topic: `Onboarding channel for ${clientName} — auto-created by CSM`,
        });
        await created.send(`👋 Welcome! This is the dedicated Echo Growth channel for **${clientName}**. Post questions here anytime.`);
        await logActivity("CSM", "channel created", `#${channelName} for ${clientName}`);
        console.log(`[CSM] Auto-created channel ${channelName}`);
      } catch (e) {
        console.error(`[CSM] Channel create failed for ${clientName}:`, e.message);
      }
    }
  } catch (e) {
    console.error("[CSM] scanForNewClientChannels:", e.message);
  }
}

// Every 10 minutes during business hours
cron.schedule("*/10 7-19 * * 1-5", () => scanForNewClientChannels());

// ─── MONDAY CHECK-INS ──────────────────────────────────────────────
cron.schedule("0 8 * * 1", async () => {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  const dashData = await getDashData();
  const info = dashData ? `We've had **${dashData.leads?.today || 0}** new leads recently and **${dashData.opportunities?.open || 0}** open opportunities.` : "";

  for (const channelId of MONITORED_CHANNELS) {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel) continue;
      const embed = new EmbedBuilder().setColor(0x34D399).setTitle("👋 Monday Check-in")
        .setDescription(`Good morning! Just checking in.\n\n${info}\n\nAnything you need this week? Drop it here.`)
        .setFooter({ text: "CSM Agent · Weekly Check-in" }).setTimestamp();
      await channel.send({ embeds: [embed] });
    } catch (e) { /* skip */ }
  }
});

if (!DISCORD_BOT_TOKEN) { console.error("[CSM] No token"); process.exit(1); }
client.login(DISCORD_BOT_TOKEN);
console.log("[CSM Agent] Starting...");
