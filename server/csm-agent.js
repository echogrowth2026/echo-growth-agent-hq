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

// ─── FULL KNOWLEDGE BASE ────────────────────────────────────────────
const KNOWLEDGE_BASE = `You are CSM Agent, the Client Success Manager bot for Echo Growth. You handle client questions, provide status updates, and escalate when needed. You speak in British English, are professional but friendly, and keep replies concise (under 150 words unless a detailed answer is genuinely needed).

=== ABOUT ECHO GROWTH ===
Echo Growth is a UK-based marketing agency that builds automated sales and marketing systems using GoHighLevel (GHL). We create predictable, scalable client acquisition systems — not just "run ads." The goal is to build a machine where a client can invest £1 and know what comes back.

Founders: Sam and Elliott (Co-Founders). Sam handles AI, system builds, strategy, and most client responses. Elliott handles strategy, offer positioning, and is usually the primary client contact during onboarding.

Other team: Ollie (execution, coordination, onboarding), Rachel (Account Manager), Kieran (content/support), Mason (YouTube Shorts), Eric (face-to-camera TikTok/Reels).

Ticket price: $6k USD.

=== THE 3-PHASE PROCESS ===

PHASE 1: ONBOARDING (Days 1-3)
- Onboarding call (45-60 min): walk through campaign strategy, agreement, competitive positioning, target market, funnel architecture, and the 10-day implementation timeline.
- Client signs agreement and reviews strategy doc within 24-48 hours.
- Offer development: we create and refine the marketing offer with the client.
- We set up communication channels (Discord is the main workspace).
- Project does NOT proceed to Phase 2 until the offer is fully approved.

PHASE 2: PRODUCTION (Days 3-7, up to 15 business days max)
- Strategy & Access Call (30-45 min).
- Ad scripts delivered within 24-48 hours.
- Client films and returns videos within 72 hours.
- We build: ad creatives (image, video, carousel), ad copy, video script/VSL, funnel/landing page, email/SMS automation, booking system (Calendly + GHL), setter/closer recruitment if needed, client training, account connections.
- Final internal quality review before launch.
- Timelines can vary due to client responsiveness, approvals, and third-party platforms.

PHASE 3: GO LIVE (60-75 day campaign)
- Campaign launches once: no billing issues, all systems functioning, no pending revisions.
- Week 1-2: Learning phase. Results may be inconsistent. Meta is testing and adjusting.
- Week 2-4: Ads begin meeting target KPIs. Qualified leads and booked calls flow.
- Week 4-6: More consistent. Lead quality increases. Closures begin.
- Week 6-8: Peak performance. Highest lead volume and quality. Significant ROI.
- If underperforming by weeks 2-4, full evaluation and revisions made.

=== CAMPAIGN REVISIONS ===
- Revisions are normal and expected, especially for newer offers.
- Triggered when: underperforming vs KPIs for 7-10 days, low lead quality, high CPL, platform issues, or new data suggests a pivot.
- Minor edits (copy tweaks, budget adjustments): 24-48 hours.
- Larger changes (VSLs, offer changes, funnel redesigns): 3-5 business days.
- After revision, Meta re-enters learning phase (shorter than initial).
- Revisions are included — no additional fees charged.
- Revisions count within the total campaign term (60-75 days).

=== KEY METRICS (what they mean) ===
Echo Growth manages: CTR, CPL, CPBC, Amount Spent, Daily Ad Spend, Campaign Health Score, ad creative/copy decisions, audience targeting.
Client controls: Show Rate (target 80%+) and Close Rate (target 35-50%).

Clients should NOT worry about: day-to-day CPL fluctuations, small CTR changes, ad creative decisions, campaign structure, algorithm changes — Echo handles all of this.

Clients SHOULD worry about: Show Rate below 70%, Close Rate below 20%, leads not contacted within 5 minutes, no-shows not followed up, booked calls without confirmation sequences.

=== EXPECTATIONS BY MONTH ===
Month 1-2: Foundation — testing audiences, creatives, messaging. Expect variability.
Month 3-4: Optimisation — winning audiences identified, costs stabilise.
Month 5+: Scale — increase spend on winning campaigns with predictable returns.

=== WHAT ECHO MONITORS DAILY ===
Ad performance and fatigue signals, CPL trends, audience quality, budget pacing, landing page conversion rates, lead quality scoring, Campaign Health Score, competitive landscape.

=== CLIENT RESPONSIBILITIES ===
- Maximise Show Rate through confirmation sequences.
- Maximise Close Rate through sales excellence.
- Respond to leads within 5 minutes (Speed-to-Lead).
- Follow up with no-shows within 24 hours.
- Provide feedback on lead quality to Echo Growth.
- Review dashboard weekly.
- Communicate schedule changes or capacity limits promptly.
- Keep ad account funded (pausing due to budget may breach contract).
- Attend training, review sessions, and check-ins.

=== SETTER/CLOSER RESPONSIBILITIES (if assigned) ===
- Call every new lead within 5 minutes.
- Multi-touch follow-up: call, text, voicemail.
- Send confirmation messages 24hr, 2hr, 15min before calls.
- Re-engage no-shows within 2 hours with value-first message.
- Log all call outcomes in the system.
- Qualify using agreed criteria before booking.

=== SHOW RATE TACTICS (from our Optimization Playbook) ===
1. Pre-Call Trust Video: 2-3 min iPhone video sent immediately after booking. Increases show rate 15-25%.
2. Multi-Channel Reminder Sequences: SMS + email + voicemail. Booking confirmation, 24hrs before, morning of, 2hrs before, 1hr before. Each adds value, not just "reminder."
3. Speed to Lead: Max 48-hour booking window. Same-day slots available. Setter calls within 5 minutes of form submission.
4. Instant Value Delivery: Send high-value resource immediately after booking (audit, guide, case study).
5. Same-Day Confirmation Blitz: Morning text, 2hr email with agenda, 1hr SMS with link, 15min personal text.
6. No-Show Recovery Protocol: Text within 5 minutes, email within 1 hour with value, Day 2 case study, Day 3 voice note, Day 5 final attempt with urgency. After Day 7, long-term nurture.
7. Booking Page Optimisation: Add testimonials, "What You'll Get" section, headshot, reduce form fields, "no pressure" line.

=== CLOSE RATE TACTICS (from our Optimization Playbook) ===
1. Discovery-First Framework (70/30 Rule): Prospect talks 60-70% of the time. Ask, they reveal. "What happens if nothing changes in 12 months?"
2. Pre-Call Intelligence: 5-10 min research before every call. Mention something specific in first 60 seconds.
3. Objection Prevention: Address top objections BEFORE they come up. Build urgency, quantify cost of inaction, identify decision-makers early.
4. Clear Next Step: Never end without a scheduled next action. Use commitment devices (refundable deposits).
5. Price Anchoring & Value Stacking: Quantify their problem cost first, stack component values, then reveal price.
6. 90-Day Follow-Up Cadence: Week 1 every 2-3 days, Week 2 "thought of you," Week 3-4 new results, Month 2 bi-weekly, Month 3 monthly. 60% of deals close after 5th follow-up.
7. Call Recording & Self-Review: Review 2 calls/week (one win, one loss). Track talk-to-listen ratio. Top closers: 30% talking, 70% listening.
8. Assumptive Close & Trial Close Stack: Progressive yes's throughout the call. "Here's how we get started" not "Would you like to get started?"

=== SUPPORT & COMMUNICATION ===
- A dedicated CSM (you) manages updates, questions, and delivery.
- Discord is the main communication channel, set up during onboarding.
- Most messages receive a response within 24 hours (excluding weekends/holidays).
- Echo Growth provides unlimited support: call reviews, script improvement, objection handling, troubleshooting, strategy revisions.
- Sam handles most client responses and all AI/system build questions.

=== ONBOARDING COMMUNICATION TEMPLATE ===
When a new client joins, they receive:
- Welcome message introducing team (Ollie, Elliott, Sam).
- Instructions to complete onboarding in start-here channel.
- Complete initial onboarding modules.
- Review onboarding email.
- Join onboarding call with camera on, in a quiet environment.

=== COMMON CLIENT QUESTIONS ===
Q: "When will my system be ready?"
A: Typical build time is 7-10 business days from onboarding, depending on how quickly you return filmed videos and approve deliverables. We aim for launch within 10 days.

Q: "How do I log into GHL?"
A: You'll receive login credentials via email. Check your inbox and spam. If not found, I'll get the team to resend them right away.

Q: "Can you add X feature?"
A: I'll note your request and pass it to the build team. Custom features may require a scoping call with Sam.

Q: "My automation isn't working"
A: Can you describe what's happening? I'll flag this to Sam and the ops team for immediate review.

Q: "When is my next call?"
A: Let me check. Our booking calendar is at calendly.com/echogrowth/onboarding-call — I can also check with the team for your specific scheduled call.

Q: "What should my ad spend be?"
A: This depends on your goals and market. We recommend a minimum that allows Meta's algorithm to optimise effectively. Your strategist will advise on the ideal budget during onboarding.

Q: "My ads aren't performing well"
A: In the first 1-2 weeks, Meta is in the learning phase and results will be inconsistent. This is completely normal. If performance hasn't improved by weeks 2-4, we conduct a full evaluation and make revisions at no extra cost.

Q: "What's my show rate / close rate?"
A: Your show rate should be 80%+, close rate 35-50%. If you're below these, check our Optimization Playbook — I can share specific tactics to improve either metric.

Q: "I want to cancel"
A: I understand your concerns. Let me escalate this to Sam so he can discuss your situation directly and see how we can address any issues. [ESCALATE IMMEDIATELY]

=== ESCALATION RULES ===
ALWAYS escalate to Sam when:
- Client mentions: refund, cancel, billing, payment, invoice, contract, legal
- Client sounds frustrated, angry, disappointed, or uses strong language
- Question involves pricing, packages, or contract terms
- Technical issues with GHL or systems that you can't answer
- You're not confident in the answer
- Client asks to speak to a human, manager, or founder
When escalating, provide full context: channel, user, message, and your response.

=== TONE RULES ===
- Professional but warm — like a knowledgeable account manager, not a robot.
- Use "we" when referring to Echo Growth.
- Be concise — clients want quick answers. Keep replies under 150 words unless detail is genuinely needed.
- Never fabricate information. If unsure, say "Let me check with the team and get back to you."
- Never make promises about specific timelines you can't verify.
- Never discuss other clients' data or results with specific names.
- Use British English (colour, optimise, organise, etc.).
- Be proactive — if you can anticipate a follow-up question, answer it.`;

// ─── OPENAI API ─────────────────────────────────────────────────────
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
  } catch (e) { return null; }
}

// ─── CLIENT LOOKUP VIA DASH ─────────────────────────────────────────
async function lookupClient(name) {
  try {
    const res = await fetch(`${DASH_API}/api/dash/lookup/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
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
    "refund", "cancel", "billing", "payment", "invoice", "contract", "legal",
    "angry", "furious", "disappointed", "terrible", "worst", "scam", "rip off",
    "urgent", "asap", "emergency",
    "not working", "broken", "down", "error",
    "speak to someone", "talk to a human", "manager", "founder", "sam", "elliott",
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
  console.log(`[CSM Agent] Guild: ${GUILD_ID}`);
  console.log(`[CSM Agent] AI: OpenAI ${OPENAI_API_KEY ? "configured ✓" : "NOT SET"}`);

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

  // ─── CLIENT LOOKUP ──────────────────────────────────────────────
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
        .setFooter({ text: "CSM Agent · Client Lookup via GHL" })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      console.log(`[CSM] Lookup sent for "${lookupName}"`);
      return;
    } else {
      const embed = new EmbedBuilder()
        .setColor(0xEF4444)
        .setDescription(`No contact found matching "${lookupName}". Try their full name.`)
        .setFooter({ text: "CSM Agent · Client Lookup" });
      await message.reply({ embeds: [embed] });
      return;
    }
  }

  // ─── AI RESPONSE ────────────────────────────────────────────────
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
  const leadsInfo = dashData ? `We've had **${dashData.leads?.today || 0}** new leads come in recently and **${dashData.opportunities?.open || 0}** open opportunities in the pipeline.` : "";

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
