import dotenv from "dotenv";
import cron from "node-cron";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { logActivity } from "./activity-log.js";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_WEBHOOK = process.env.STRT_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;
const DASH_API = process.env.DASH_API || "https://echo-growth-agent-hq-production.up.railway.app";

async function callOpenAI(systemPrompt, userMessage, maxTokens = 2000) {
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
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

async function getDashSnapshot() {
  try {
    const [dashRes, briefRes, discordRes] = await Promise.all([
      fetch(`${DASH_API}/api/dash`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${DASH_API}/api/dash/briefings`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${DASH_API}/api/dash/discord-stats`, { signal: AbortSignal.timeout(8000) }),
    ]);
    const dash = dashRes.ok ? await dashRes.json() : null;
    const briefings = briefRes.ok ? await briefRes.json() : { briefings: [] };
    const discord = discordRes.ok ? await discordRes.json() : null;
    return { dash, briefings: briefings.briefings || [], discord };
  } catch { return { dash: null, briefings: [], discord: null }; }
}

export async function analyseStrategy(question = null) {
  const { dash, briefings, discord } = await getDashSnapshot();

  const historyBlob = briefings.slice(0, 10).map(b => {
    const s = b.summary || {};
    return `[${b.timestamp.slice(0, 10)} ${b.type}] leads:${s.leads?.today || 0} show%:${s.bookings?.showRate || 0} open:${s.opportunities?.open || 0}`;
  }).join("\n") || "(no briefing history)";

  const pipelineBlob = dash?.opportunities?.pipelines?.map(p => {
    const stages = Object.entries(p.stages || {}).map(([n, c]) => `${n}:${c}`).join(", ");
    return `${p.name} (${p.total} total): ${stages}`;
  }).join("\n") || "(no pipeline data)";

  const discordBlob = discord
    ? `Today → leads:${discord.today.leads} calls:${discord.today.calls} payments:${discord.today.payments} (£${(discord.today.paymentsAmount || 0).toLocaleString()})`
    : "(no Discord counters)";

  const prompt = `You are the strategy analyst at Echo Growth. Based on live data, produce a strategic brief.

Return STRICT JSON (no markdown fences):
{
  "headline": "<one sentence overview of the week>",
  "lead_quality_trend": "<UP | FLAT | DOWN with brief reasoning>",
  "booking_pattern": "<observation>",
  "pipeline_health": "<assessment>",
  "offer_performance": "<what's working / not>",
  "positioning_adjustment": "<concrete suggestion or 'no change'>",
  "niche_pivot": "<suggestion or 'no pivot recommended'>",
  "creative_direction": "<brief guidance for COPY + CRTV>",
  "top_3_actions": ["<action 1>", "<action 2>", "<action 3>"]
}

${question ? `SPECIFIC QUESTION FROM SAM: "${question}" — weight your answer towards this.` : ""}`;

  const user = `BRIEFING HISTORY (most recent first):
${historyBlob}

PIPELINE SNAPSHOT:
${pipelineBlob}

DISCORD COUNTERS:
${discordBlob}

CURRENT METRICS:
- Total leads: ${dash?.leads?.total || 0}
- Today's leads: ${dash?.leads?.today || 0}
- Open opps: ${dash?.opportunities?.open || 0}
- Won: ${dash?.opportunities?.won || 0}
- Lost: ${dash?.opportunities?.lost || 0}
- Show rate: ${dash?.bookings?.showRate || 0}%
- Pipeline value: £${(dash?.opportunities?.totalValue || 0).toLocaleString()}`;

  const raw = await callOpenAI(prompt, user);
  if (!raw) return null;

  let parsed;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return { error: "parse_failed", raw }; }

  const entry = {
    id: `strt_${Date.now()}`,
    timestamp: new Date().toISOString(),
    question,
    analysis: parsed,
  };

  await postStrategyReport(entry);
  await logActivity("STRT", question ? "ad-hoc analysis" : "weekly brief", parsed.headline || "done");
  return entry;
}

async function postStrategyReport(entry) {
  if (!DISCORD_WEBHOOK) return;
  const a = entry.analysis || {};
  const trendIcon = a.lead_quality_trend?.startsWith("UP") ? "📈" : a.lead_quality_trend?.startsWith("DOWN") ? "📉" : "➡️";

  const embed = {
    title: `🧠 STRT Agent — ${entry.question ? "On-Demand Analysis" : "Weekly Strategy Brief"}`,
    description: a.headline || "Analysis complete",
    color: 0xE879F9,
    fields: [
      { name: `${trendIcon} Lead Quality`, value: a.lead_quality_trend || "—", inline: true },
      { name: "📅 Bookings", value: a.booking_pattern || "—", inline: true },
      { name: "💰 Pipeline", value: a.pipeline_health || "—", inline: true },
      { name: "🎯 Offer", value: a.offer_performance || "—", inline: false },
      { name: "🧩 Positioning", value: a.positioning_adjustment || "—", inline: false },
      { name: "🌐 Niche Pivot", value: a.niche_pivot || "—", inline: false },
      { name: "🎨 Creative Direction", value: a.creative_direction || "—", inline: false },
      { name: "✅ Top 3 Actions", value: (a.top_3_actions || []).map((x, i) => `${i + 1}. ${x}`).join("\n") || "—", inline: false },
    ],
    footer: { text: "ECHO GROWTH · AGENT HQ — STRT" },
    timestamp: new Date().toISOString(),
  };
  if (entry.question) embed.fields.unshift({ name: "❓ Question", value: entry.question.substring(0, 1024), inline: false });

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "STRT Agent", embeds: [embed] }),
    });
  } catch (e) { console.error("[STRT] Discord failed:", e.message); }
}

const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  // Sundays at 7pm UTC
  cron.schedule("0 19 * * 0", () => analyseStrategy());
  console.log("[STRT Agent] Started — Weekly brief Sundays 7pm UTC");
}
