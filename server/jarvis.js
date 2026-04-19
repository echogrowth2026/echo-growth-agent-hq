// JARVIS — the central brain. Not a forked agent; a request-response
// module mounted onto the DASH Express server. Given a command (typed
// or transcribed from voice), it:
//   1. Classifies intent via OpenAI
//   2. Routes to the correct in-process agent function or HTTP endpoint
//   3. Takes the raw agent response and formats a natural spoken reply
//   4. Optionally renders TTS via ElevenLabs and returns an audio URL
//
// Agent calls are made IN-PROCESS against imported functions where
// possible (faster, no self-loopback over HTTP) and fall back to fetch
// only when the data isn't exposed as a function import.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CONVO_DIR = path.join(__dirname, "data", "jarvis");
const CONVO_PATH = path.join(CONVO_DIR, "conversation.json");

// ─── KNOWLEDGE BASE ─────────────────────────────────────────────────
// Lives in server/data/jarvis-knowledge.md so Sam can edit it without
// redeploying. Hot-reloaded every 60s. Injected into the conversation
// handler and the spoken-response formatter — NOT the intent
// classifier (that prompt stays lean so every classification doesn't
// pay for the full KB in prompt tokens).
const KB_PATH = path.join(__dirname, "data", "jarvis-knowledge.md");
let KB_CACHE = null;
let KB_LOADED_AT = 0;
function loadKnowledgeBase() {
  if (KB_CACHE !== null && Date.now() - KB_LOADED_AT < 60_000) return KB_CACHE;
  try { KB_CACHE = fs.readFileSync(KB_PATH, "utf8"); }
  catch (e) { KB_CACHE = ""; console.warn("[JARVIS] KB not loaded:", e.message); }
  KB_LOADED_AT = Date.now();
  return KB_CACHE;
}

function ensureConvo() {
  if (!fs.existsSync(CONVO_DIR)) fs.mkdirSync(CONVO_DIR, { recursive: true });
  if (!fs.existsSync(CONVO_PATH)) fs.writeFileSync(CONVO_PATH, "[]");
}
function readConvo() { try { return JSON.parse(fs.readFileSync(CONVO_PATH, "utf8")); } catch { return []; } }
function writeConvo(d) { fs.writeFileSync(CONVO_PATH, JSON.stringify(d.slice(-200), null, 2)); }

export function getConversation(limit = 50) {
  ensureConvo();
  return readConvo().slice(-limit);
}

// ─── OPENAI PLUMBING ────────────────────────────────────────────────
async function openai(systemPrompt, userMessage, { maxTokens = 500, json = false, model = "gpt-4o-mini" } = {}) {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error(`[JARVIS] OpenAI ${res.status}: ${t.substring(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("[JARVIS] OpenAI error:", e.message);
    return null;
  }
}

// ─── INTENT CLASSIFIER ──────────────────────────────────────────────
const INTENT_PROMPT = `You are Jarvis, the AI brain for Echo Growth Agent HQ. You control 13 agents that run a marketing agency. Classify the user's command into one of these intents and extract parameters:

Intents:
- LOOKUP: client lookup. Params: {name}
- PIPELINE: show pipeline data. Params: {pipeline_name?}
- METRICS: show current metrics. Params: {metric_type?}
- GENERATE_COPY: create ad copy. Params: {niche, offer?, audience?}
- GENERATE_CREATIVE: create ad images. Params: {niche, style?, copy_text?}
- GENERATE_BRIEF: create creative brief. Params: {niche, topic?}
- STRATEGY: strategy analysis. Params: {question}
- FUNNEL: funnel stats. Params: {funnel_name?}
- COMPETITOR: competitor analysis. Params: {niche}
- AGENT_STATUS: check agent status. Params: {agent_name?}
- REVIEW: show pending reviews. Params: {type?}
- SEND_CHECKIN: send client check-ins. Params: {}
- BUILD_WORKFLOW: create GHL workflow. Params: {name, trigger, steps}
- BUILD_AUTOMATION: create n8n automation. Params: {name, trigger, steps}
- LINKEDIN: generate a LinkedIn post. Params: {topic?, style?}
- OPEN_BROWSER: open a URL on Sam's desktop. Params: {url, service?}
- LOGIN_SERVICE: log in to a service on the desktop. Params: {service} (ghl | n8n | linkedin | discord)
- BUILD_IN_BROWSER: perform a task in a service via the desktop browser. Params: {service, task_description}
- POST_LINKEDIN: publish a LinkedIn post NOW via the desktop agent. Triggers include "post on linkedin", "post a linkedin", "share on linkedin", "linkedin post saying ...", "linkedin post about ...". Extract the post text from the command (everything after "saying"/"about", or the whole message minus the trigger phrase). Params: {text?, post_id?, content?}
- SWITCH_GHL_SUBACCOUNT: switch the active GHL sub-account via the desktop browser. Triggers: "switch to <x> subaccount", "go into <x>", "open <x> in ghl", "switch client to <x>". Extract the sub-account name (remove words like "the", "subaccount", "sub-account", "client", "in ghl"). Params: {subaccountName}
- NAV_GHL_PAGE: click a GHL sidebar page (optionally switching sub-account first). Triggers: "go to <page>", "open <page>", "navigate to <page>", "show me <page>", "go to <page> in <subaccount>". Valid pages: dashboard, conversations, calendars, contacts, opportunities, payments, marketing, automation, sites, memberships, reputation, reporting, settings. Map synonyms (deals→opportunities, workflows→automation, funnels→sites, messages→conversations). Params: {page, subaccountName?}
- IMPORT_N8N: import an approved n8n workflow on the desktop. Params: {workflow_id}
- DESKTOP_STATUS: check if the desktop companion is connected. Params: {}
- CONVERSATION: general chat, not a command. Params: {}

Respond ONLY with JSON: {"intent":"...","params":{...},"confidence":0.0-1.0}`;

export async function classifyIntent(text) {
  const raw = await openai(INTENT_PROMPT, text, { maxTokens: 220, json: true });
  if (!raw) return { intent: "CONVERSATION", params: {}, confidence: 0 };
  try {
    const parsed = JSON.parse(raw);
    return {
      intent: parsed.intent || "CONVERSATION",
      params: parsed.params || {},
      confidence: Number(parsed.confidence) || 0,
    };
  } catch {
    return { intent: "CONVERSATION", params: {}, confidence: 0 };
  }
}

// ─── AGENT HANDLERS ─────────────────────────────────────────────────
// Built lazily so jarvis.js can be imported by agents that don't have
// every dependency (e.g. dash-agent constructs the handler map at
// request time with its own in-process references).
export function buildHandlers(ctx) {
  const {
    lookupClient, getPipelines, runDashAgent, dashCache,
    generateCopy, generateCreative, analyseStrategy,
    adspyLatestForNiche, adspyAnalyse,
    runAdlibScan, runFunnelScan, generateAds,
    listReviewPending, getActivity,
    generateN8nWorkflow, generateGhlWorkflow, generateLinkedinPost,
    sendToDesktop, desktopStatus,
    postLinkedinPost, importN8nWorkflow,
  } = ctx;

  const needDesktop = async () => {
    if (!sendToDesktop) return { summary: "Desktop companion not wired into this deployment", data: null };
    return null;
  };

  return {
    LOOKUP: async (p) => {
      if (!p?.name) return { summary: "No name provided — who should I look up?" };
      const r = await lookupClient(p.name);
      return {
        summary: r.found ? `Found ${r.count} contact${r.count === 1 ? "" : "s"} matching "${p.name}"` : (r.message || "Not found"),
        data: r,
      };
    },
    PIPELINE: async () => ({ summary: "Current pipelines", data: { pipelines: await getPipelines() } }),
    METRICS: async () => {
      const data = dashCache?.data || await runDashAgent("refresh");
      return {
        summary: `${data?.leads?.today || 0} new leads today, ${data?.opportunities?.open || 0} open opps, show rate ${data?.bookings?.showRate || 0}%`,
        data,
      };
    },
    GENERATE_COPY: async (p) => {
      const entry = await generateCopy(p || {});
      return { summary: entry ? `Generated ad copy for ${p?.niche || "the requested niche"}` : "Copy generation failed", data: entry };
    },
    GENERATE_CREATIVE: async (p) => {
      const result = await generateAds({
        niche: p?.niche,
        style: p?.style,
        copyText: p?.copy_text || p?.copyText,
      });
      return {
        summary: result?.creative?.imageUrls?.length
          ? `Generated ${result.creative.imageUrls.length} creative variants for ${p?.niche || "B2B"}`
          : `Creative generation failed${result?.error ? `: ${result.error}` : ""}`,
        data: result,
      };
    },
    GENERATE_BRIEF: async (p) => {
      const entry = await generateCreative({ niche: p?.niche, topic: p?.topic });
      return { summary: entry ? "Creative brief generated" : "Brief generation failed", data: entry };
    },
    STRATEGY: async (p) => {
      const entry = await analyseStrategy(p?.question || null);
      return { summary: entry ? "Strategy analysis complete" : "Analysis failed", data: entry };
    },
    FUNNEL: async () => {
      const report = await runFunnelScan();
      return { summary: report ? "Funnel scan complete" : "Funnel scan failed", data: report };
    },
    COMPETITOR: async (p) => {
      if (!p?.niche) return { summary: "Which niche should I analyse?" };
      const entry = adspyLatestForNiche(p.niche) || await adspyAnalyse(p.niche);
      return { summary: entry ? `Competitor intel for ${p.niche}` : "No data", data: entry };
    },
    AGENT_STATUS: async () => ({ summary: "Recent agent activity", data: { activity: getActivity(30) } }),
    REVIEW: async () => {
      const pending = listReviewPending();
      return { summary: `${pending.length} items awaiting review`, data: { pending } };
    },
    SEND_CHECKIN: async () => ({ summary: "Client check-ins queued — CSM will handle Monday dispatch", data: {} }),
    BUILD_WORKFLOW: async (p) => {
      if (!generateGhlWorkflow) return { summary: "GHL workflow builder unavailable", data: null };
      const entry = await generateGhlWorkflow(p || {});
      return { summary: entry ? `GHL workflow "${entry.name}" queued for review` : "Workflow generation failed", data: entry };
    },
    BUILD_AUTOMATION: async (p) => {
      if (!generateN8nWorkflow) return { summary: "N8N builder unavailable", data: null };
      const entry = await generateN8nWorkflow(p || {});
      return { summary: entry ? `N8N automation "${entry.name}" queued for review` : "Automation generation failed", data: entry };
    },
    LINKEDIN: async (p) => {
      if (!generateLinkedinPost) return { summary: "LinkedIn agent unavailable", data: null };
      const entry = await generateLinkedinPost(p || {});
      return { summary: entry ? "LinkedIn post drafted — check the Review tab" : "LinkedIn generation failed", data: entry };
    },

    OPEN_BROWSER: async (p) => {
      const blocked = await needDesktop(); if (blocked) return blocked;
      if (!p?.url && !p?.service) return { summary: "Which URL or service should I open?", data: null };
      try {
        const result = await sendToDesktop({ type: "OPEN_URL", url: p.url, service: p.service });
        return { summary: `Opened ${p.url || p.service} on the desktop`, data: result };
      } catch (e) { return { summary: `Desktop open failed: ${e.message}`, data: null }; }
    },

    LOGIN_SERVICE: async (p) => {
      const blocked = await needDesktop(); if (blocked) return blocked;
      if (!p?.service) return { summary: "Which service should I log into?", data: null };
      try {
        const result = await sendToDesktop({ type: "LOGIN", service: p.service });
        return { summary: `Login flow started for ${p.service} on the desktop`, data: result };
      } catch (e) { return { summary: `Login failed: ${e.message}`, data: null }; }
    },

    BUILD_IN_BROWSER: async (p) => {
      const blocked = await needDesktop(); if (blocked) return blocked;
      if (!p?.service || !p?.task_description) return { summary: "Tell me which service and what to build.", data: null };
      try {
        const result = await sendToDesktop({
          type: "BROWSER_ACTION",
          action: { service: p.service, type: "plan-and-execute", task: p.task_description },
        }, { timeoutMs: 180_000 });
        return { summary: `Desktop attempted: ${p.task_description}`, data: result };
      } catch (e) { return { summary: `Desktop build failed: ${e.message}`, data: null }; }
    },

    POST_LINKEDIN: async (p) => {
      const blocked = await needDesktop(); if (blocked) return blocked;
      if (!postLinkedinPost) return { summary: "LinkedIn posting flow not wired", data: null };
      try {
        const result = await postLinkedinPost({
          postId: p?.post_id,
          content: p?.content,
          text: p?.text,
        });
        if (result?.ok && result?.stage === "published") {
          return { summary: "Posted to LinkedIn", data: result };
        }
        if (result?.stage === "awaiting_confirm") {
          return { summary: "Post pasted — confirm in the Review tab to publish", data: result };
        }
        return { summary: `LinkedIn post failed: ${result?.error || "unknown"}`, data: result };
      } catch (e) { return { summary: `LinkedIn post failed: ${e.message}`, data: null }; }
    },

    IMPORT_N8N: async (p) => {
      const blocked = await needDesktop(); if (blocked) return blocked;
      if (!p?.workflow_id) return { summary: "Which workflow id should I import?", data: null };
      if (!importN8nWorkflow) return { summary: "N8N importer not wired", data: null };
      try {
        const result = await importN8nWorkflow(p.workflow_id);
        return { summary: result?.ok ? "N8N workflow imported on desktop" : `Import failed: ${result?.error || "unknown"}`, data: result };
      } catch (e) { return { summary: `Import failed: ${e.message}`, data: null }; }
    },

    DESKTOP_STATUS: async () => {
      const status = desktopStatus ? desktopStatus() : { connected: false };
      return {
        summary: status.connected
          ? `Desktop companion is connected${status.authenticated ? " and authenticated" : " (not yet authenticated)"}`
          : "Desktop companion is offline",
        data: status,
      };
    },

    SWITCH_GHL_SUBACCOUNT: async (p) => {
      const blocked = await needDesktop(); if (blocked) return blocked;
      const name = (p?.subaccountName || p?.subaccount || p?.name || "").trim();
      if (!name) return { summary: "Which sub-account should I switch to?", data: null };
      try {
        const result = await sendToDesktop({
          type: "execute_template",
          name: "ghl_switch_subaccount",
          params: { subaccountName: name },
        }, { timeoutMs: 60_000 });
        if (result?.success) {
          return { summary: `Switched to ${result.result?.subaccountName || name}`, data: result };
        }
        return { summary: `Couldn't switch: ${result?.error || "unknown error"}`, data: result };
      } catch (e) { return { summary: `Sub-account switch failed: ${e.message}`, data: null }; }
    },

    NAV_GHL_PAGE: async (p) => {
      const blocked = await needDesktop(); if (blocked) return blocked;
      const pageName = (p?.page || "").toLowerCase().trim();
      if (!pageName) return { summary: "Which page should I open?", data: null };
      try {
        const result = await sendToDesktop({
          type: "execute_template",
          name: "ghl_navigate_to_page",
          params: {
            page: pageName,
            ...(p?.subaccountName ? { subaccountName: String(p.subaccountName).trim() } : {}),
          },
        }, { timeoutMs: 90_000 });
        if (result?.success) {
          const where = p?.subaccountName ? ` in ${p.subaccountName}` : "";
          return { summary: `Opened the ${pageName} page${where}`, data: result };
        }
        return { summary: `Couldn't open ${pageName}: ${result?.error || "unknown error"}`, data: result };
      } catch (e) { return { summary: `Navigation failed: ${e.message}`, data: null }; }
    },
    CONVERSATION: async (_, text) => {
      const kb = loadKnowledgeBase();
      const system = `${kb}

---

You are speaking with Sam right now. Respond to casual conversation concisely. Confident, direct, slightly witty British English. Keep replies to two sentences unless a detailed answer is genuinely needed. Draw on the knowledge above when relevant — don't force it in. Never fabricate.`;
      const reply = await openai(system, text, { maxTokens: 220 });
      return { summary: reply || "I'm here.", data: null };
    },
  };
}

// ─── RESPONSE FORMATTER ─────────────────────────────────────────────
async function formatSpokenResponse({ question, intent, agentSummary, data }) {
  const base = agentSummary || "Done.";
  // For CONVERSATION we already have a natural reply — pass through.
  if (intent === "CONVERSATION") return base;
  const context = typeof data === "object" ? JSON.stringify(data).substring(0, 1800) : String(data || "");
  const kb = loadKnowledgeBase();
  const system = `${kb}

---

You are Jarvis speaking to Sam. Format the agent result below into a natural spoken response grounded in the knowledge above. Be concise, confident, useful, British English. Max two sentences. No bullet points, no markdown — this is read aloud by ElevenLabs. If a metric needs context ("80% show rate is target"), include it. Never fabricate.`;
  const reply = await openai(
    system,
    `Sam asked: "${question}"\nAgent result: ${base}\nData snippet: ${context}`,
    { maxTokens: 160 },
  );
  return reply || base;
}

// ─── MAIN ENTRY ─────────────────────────────────────────────────────
export async function runJarvisCommand({ text, ctx, voice = false, speakFn = null }) {
  ensureConvo();
  const trimmed = (text || "").trim();
  if (!trimmed) return { ok: false, error: "empty command" };

  const classification = await classifyIntent(trimmed);
  const handlers = buildHandlers(ctx || {});
  const handler = handlers[classification.intent] || handlers.CONVERSATION;

  let agentResult = { summary: "Handler missing", data: null };
  try {
    agentResult = await handler(classification.params || {}, trimmed) || agentResult;
  } catch (e) {
    console.error(`[JARVIS] Handler ${classification.intent} failed:`, e.message);
    agentResult = { summary: `That failed: ${e.message}`, data: null };
  }

  const spoken = await formatSpokenResponse({
    question: trimmed,
    intent: classification.intent,
    agentSummary: agentResult.summary,
    data: agentResult.data,
  });

  let audioUrl = null;
  if (voice && speakFn) {
    try { audioUrl = await speakFn(spoken); }
    catch (e) { console.error("[JARVIS] TTS failed:", e.message); }
  }

  const entry = {
    id: `jv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    command: trimmed,
    voice,
    intent: classification.intent,
    confidence: classification.confidence,
    response: spoken,
    audioUrl,
    data: agentResult.data || null,
  };

  const convo = readConvo();
  convo.push(entry);
  writeConvo(convo);

  return { ok: true, ...entry };
}
