// Natural-language router for the Jarvis command bar.
// Pattern-first so obvious commands are instant and cheap.
// OpenAI fallback only kicks in for ambiguous inputs.

import { generateCopy } from "./copy-agent.js";
import { generateCreative } from "./crtv-agent.js";
import { analyseStrategy } from "./strt-agent.js";
import { runFunnelScan } from "./funl-agent.js";
import { runAdlibScan, getLatestSnapshot as getAdlibSnapshot } from "./adlib-agent.js";
import { analyseNiche, getLatestForNiche } from "./adspy-agent.js";
import { generateAds } from "./adgen-agent.js";
import { listPending as listReviewPending } from "./review-queue.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const PATTERNS = [
  { rx: /^(?:look\s+up|find|where\s+is|status\s+of|check\s+on)\s+(.+)$/i, handler: "lookup" },
  { rx: /^generate\s+(?:ad\s+)?copy\s+for\s+(.+)$/i,                       handler: "generateCopy" },
  { rx: /^(?:write|create)\s+(?:ad\s+)?copy\s+for\s+(.+)$/i,               handler: "generateCopy" },
  { rx: /^(?:generate|create)\s+creatives?\s+for\s+(.+)$/i,                handler: "generateAds" },
  { rx: /^(?:create|build)\s+(?:a\s+)?brief\s+(?:for\s+)?(.+)?$/i,         handler: "generateBrief" },
  { rx: /^brief\s+the\s+team(?:\s+(?:on|for)\s+(.+))?$/i,                  handler: "generateBrief" },
  { rx: /^(?:analyse|analyze)\s+(.+)$/i,                                   handler: "strategy" },
  { rx: /^should\s+we\s+(.+)\??$/i,                                        handler: "strategy" },
  { rx: /^what\s+about\s+(.+)\??$/i,                                       handler: "strategy" },
  { rx: /^(?:show|check)\s+(?:me\s+)?(?:the\s+)?pipelines?$/i,             handler: "pipelines" },
  { rx: /^(?:show\s+(?:me\s+)?)?competitor\s+ads?\s+for\s+(.+)$/i,         handler: "adspy" },
  { rx: /^(?:check|scan)\s+funnel(?:s|\s+conversions?)?$/i,                handler: "funnel" },
  { rx: /^(?:ad\s+library|creative\s+trends?|ad\s+insights?)$/i,           handler: "adlib" },
  { rx: /^what'?s?\s+pending(?:\s+review)?$/i,                             handler: "reviewQueue" },
  { rx: /^(?:send\s+)?check-?in\s+(?:to\s+)?(?:all\s+)?clients?$/i,        handler: "checkIn" },
  { rx: /^(?:how\s+are\s+we|what'?s?\s+the\s+show\s+rate|metrics?|performance)\b/i, handler: "metrics" },
];

async function openAIClassify(text) {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content: `You route commands for Echo Growth's agent system. Return STRICT JSON:
{"intent": "<one of: lookup|generateCopy|generateAds|generateBrief|strategy|pipelines|funnel|adspy|adlib|metrics|checkIn|reviewQueue|conversation>", "subject": "<the key phrase/name/niche>"}
Intent definitions:
- lookup: find a specific client by name
- generateCopy: produce ad copy variants
- generateAds: produce ad creative images
- generateBrief: produce a creative brief / script
- strategy: strategy question or niche analysis
- pipelines: show pipeline data
- funnel: scan funnel conversions
- adspy: competitor ad intel for a niche
- adlib: creative intelligence report
- metrics: general performance numbers
- checkIn: send client check-in
- reviewQueue: show pending review items
- conversation: just a conversational reply, no agent action needed`,
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch { return null; }
}

async function conversationalReply(text) {
  if (!OPENAI_API_KEY) return `I can't route that automatically. Try: "look up [name]", "generate ad copy for [niche]", "analyse [niche]", "what's the show rate", or "what's pending review".`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 350,
        messages: [
          { role: "system", content: "You are Echo Growth's in-app command assistant. Be brief, British English, useful. When the user's intent isn't clear enough to route, clarify in one or two sentences. When they're just chatting, reply conversationally." },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return "I couldn't reach OpenAI — try rephrasing.";
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "No response.";
  } catch (e) { return `Error: ${e.message}`; }
}

// Handlers take (text, subject, ctx) and return { agent, type, result }
const HANDLERS = {
  async lookup(text, subject, ctx) {
    const name = subject || text;
    const result = await ctx.lookupClient(name);
    return { agent: "DASH", type: "lookup", result };
  },
  async generateCopy(_t, subject) {
    const niche = subject || "B2B service businesses";
    const result = await generateCopy({ niche });
    return { agent: "COPY", type: "generate", result };
  },
  async generateAds(_t, subject) {
    const niche = subject || "B2B service businesses";
    const result = await generateAds({ niche });
    return { agent: "ADGEN", type: "generate", result };
  },
  async generateBrief(_t, subject) {
    const niche = subject || "B2B service businesses";
    const result = await generateCreative({ niche });
    return { agent: "CRTV", type: "brief", result };
  },
  async strategy(_t, subject) {
    const question = subject || _t;
    const result = await analyseStrategy(question);
    return { agent: "STRT", type: "analysis", result };
  },
  async pipelines(_t, _s, ctx) {
    const result = await ctx.getPipelines();
    return { agent: "DASH", type: "pipelines", result: { pipelines: result } };
  },
  async funnel() {
    const result = await runFunnelScan();
    return { agent: "FUNL", type: "scan", result };
  },
  async adspy(_t, subject) {
    const niche = subject || "B2B service businesses";
    const cached = getLatestForNiche(niche);
    if (cached) return { agent: "ADSPY", type: "cached", result: cached };
    const result = await analyseNiche(niche);
    return { agent: "ADSPY", type: "fresh", result };
  },
  async adlib() {
    const cached = getAdlibSnapshot();
    if (cached) return { agent: "ADLIB", type: "cached", result: cached };
    const result = await runAdlibScan();
    return { agent: "ADLIB", type: "fresh", result };
  },
  async metrics(_t, _s, ctx) {
    const result = ctx.dashCache?.data || await ctx.runDashAgent("refresh");
    return { agent: "DASH", type: "metrics", result };
  },
  async checkIn(_t, _s, ctx) {
    if (ctx.triggerCheckIn) await ctx.triggerCheckIn();
    return { agent: "CSM", type: "checkIn", result: { triggered: true, note: "Monday-style check-in dispatched" } };
  },
  async reviewQueue() {
    return { agent: "REVIEW", type: "pending", result: { pending: listReviewPending() } };
  },
  async conversation(text) {
    const reply = await conversationalReply(text);
    return { agent: "ASSISTANT", type: "reply", result: { reply } };
  },
};

export async function routeCommand(text, ctx = {}) {
  const clean = (text || "").trim();
  if (!clean) return { ok: false, error: "empty command" };

  // 1. Pattern match
  for (const { rx, handler } of PATTERNS) {
    const m = clean.match(rx);
    if (m) {
      try {
        const out = await HANDLERS[handler](clean, (m[1] || "").trim(), ctx);
        return { ok: true, ...out };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  }

  // 2. OpenAI classification fallback
  const classified = await openAIClassify(clean);
  if (classified?.intent && HANDLERS[classified.intent]) {
    try {
      const out = await HANDLERS[classified.intent](clean, classified.subject || "", ctx);
      return { ok: true, ...out, routedVia: "openai" };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // 3. Pure conversational reply
  try {
    const out = await HANDLERS.conversation(clean);
    return { ok: true, ...out, routedVia: "conversation" };
  } catch (e) { return { ok: false, error: e.message }; }
}
