import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { logActivity } from "./activity-log.js";
import { addCreative, imagesDir } from "./ad-library.js";
import { addToReview } from "./review-queue.js";
import { getLatestPerformance, getTopCampaigns } from "./adlib-agent.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HIGGSFIELD_API_KEY = process.env.HIGGSFIELD_API_KEY;
const HIGGSFIELD_API_SECRET = process.env.HIGGSFIELD_API_SECRET || null;
// Endpoint is env-configurable because Higgsfield's public API shape is
// still changing. We probe a list of known hosts/paths until one
// authenticates; HIGGSFIELD_ENDPOINT forces a single endpoint.
const HIGGSFIELD_ENDPOINT = process.env.HIGGSFIELD_ENDPOINT || null;
const HIGGSFIELD_CANDIDATE_ENDPOINTS = HIGGSFIELD_ENDPOINT ? [HIGGSFIELD_ENDPOINT] : [
  "https://platform.higgsfield.ai/v1/generations",
  "https://api.higgsfield.ai/v1/generations",
  "https://cloud.higgsfield.ai/api/v1/generations",
];
const DISCORD_WEBHOOK = process.env.ADGEN_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VARIANTS_PER_REQUEST = 4;

// ─── PROMPT TEMPLATES ───────────────────────────────────────────────
// Loaded from server/data/adgen-templates.json so Sam can tweak niche
// styling without redeploying. Falls back to an inline default block.
const TEMPLATES_PATH = path.join(__dirname, "data", "adgen-templates.json");
let TEMPLATE_CACHE = null;
let TEMPLATE_LOADED_AT = 0;
function loadTemplates() {
  // Re-read if > 60s old so edits to the JSON take effect quickly.
  if (TEMPLATE_CACHE && Date.now() - TEMPLATE_LOADED_AT < 60_000) return TEMPLATE_CACHE;
  try {
    const raw = fs.readFileSync(TEMPLATES_PATH, "utf8");
    TEMPLATE_CACHE = JSON.parse(raw);
  } catch {
    TEMPLATE_CACHE = {
      templates: {
        default: {
          style: "Modern, professional, clean",
          colours: "Dark with accent",
          composition: "Product or service focused, clear text overlay space",
          promptBase: "Professional business marketing image, modern and clean, commercial quality",
        },
      },
      aliases: {},
    };
  }
  TEMPLATE_LOADED_AT = Date.now();
  return TEMPLATE_CACHE;
}

function chooseTemplate(niche) {
  const lib = loadTemplates();
  const key = (niche || "").toLowerCase();
  // Direct hit on template key
  if (lib.templates[key]) return { key, template: lib.templates[key] };
  // Alias hit (e.g. "dentist" → "clinics")
  for (const [tplKey, aliases] of Object.entries(lib.aliases || {})) {
    if (aliases.some(a => key.includes(a))) {
      return { key: tplKey, template: lib.templates[tplKey] || lib.templates.default };
    }
  }
  // Substring match on template name
  for (const tplKey of Object.keys(lib.templates)) {
    if (tplKey !== "default" && key.includes(tplKey.replace(/-/g, " ").slice(0, -1))) {
      return { key: tplKey, template: lib.templates[tplKey] };
    }
  }
  return { key: "default", template: lib.templates.default };
}

async function buildPrompt({ niche, offer, audience, copyText, style, template }) {
  // Template-driven fallback so every niche gets its signature look even
  // when OpenAI is down. Template wins over generic style note.
  const tplPrompt = template
    ? `${template.promptBase}. Style: ${template.style}. Colour palette: ${template.colours}. Composition: ${template.composition}.`
    : style || "Bright, clean, high-contrast, modern, commercial photography. Product/founder-forward. Readable text overlay space top-right.";
  const fallback = `Professional Meta ad creative for ${niche || "B2B service businesses"}. ${tplPrompt} Offer: ${offer || ""}. Headline vibe: ${copyText || ""}.`;
  if (!OPENAI_API_KEY) return fallback;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 220,
        messages: [
          { role: "system", content: "Produce one Higgsfield-style image generation prompt (under 90 words) for a Meta ad creative. Anchor it in the provided niche template — honour its style, colour palette, and composition note. Be specific about subject, lighting, mood, and copy-overlay space. No disclaimers, no 'Sure, here is' prefixes." },
          { role: "user", content: `Niche: ${niche}\nOffer: ${offer || ""}\nAudience: ${audience || ""}\nAd copy to visualise: ${copyText || ""}\nTemplate guidance:\n${tplPrompt}\nExtra style note: ${style || ""}` },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || fallback;
  } catch { return fallback; }
}

// Higgsfield's public API is still evolving and different hosts want
// different auth shapes. We probe combinations of (endpoint × auth
// strategy) until one returns a non-401. The winning pair is cached so
// subsequent calls skip the probing overhead.
let CACHED_HIGGSFIELD = null; // { endpoint, authFn }

function higgsfieldAuthStrategies() {
  const key = HIGGSFIELD_API_KEY;
  const secret = HIGGSFIELD_API_SECRET;
  const strategies = [];

  if (key && secret) {
    strategies.push({
      label: "hf-headers",
      headers: { "hf-api-key": key, "hf-secret": secret },
    });
    strategies.push({
      label: "basic-auth",
      headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}` },
    });
    strategies.push({
      label: "bearer-combined",
      headers: { Authorization: `Bearer ${key}:${secret}` },
    });
    strategies.push({
      label: "x-api-id-secret",
      headers: { "x-api-id": key, "x-api-secret": secret },
    });
  }
  if (key) {
    strategies.push({
      label: "bearer",
      headers: { Authorization: `Bearer ${key}` },
    });
    strategies.push({
      label: "x-api-key",
      headers: { "x-api-key": key },
    });
    strategies.push({
      label: "query-key",
      query: { api_key: key },
    });
  }
  return strategies;
}

function buildHiggsfieldRequest(endpoint, strategy, body) {
  let url = endpoint;
  if (strategy.query) {
    const u = new URL(endpoint);
    for (const [k, v] of Object.entries(strategy.query)) u.searchParams.set(k, v);
    url = u.toString();
  }
  return {
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(strategy.headers || {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    },
  };
}

function parseHiggsfieldImages(data) {
  return (
    data?.images?.map(i => i.url || i) ||
    data?.data?.map(i => i.url || i) ||
    data?.outputs?.map(i => i.url || i) ||
    data?.result?.images?.map(i => i.url || i) ||
    []
  ).filter(Boolean);
}

// ─── DALL-E 3 FALLBACK ──────────────────────────────────────────────
// OpenAI's DALL-E 3 generates one image per call. For a creative batch
// we build 3-4 per-variant prompts (main / lifestyle / bold-text /
// testimonial) from the same template + copy, then generate each
// sequentially. Used when Higgsfield returns no images for any reason.
const VARIANT_STYLES = [
  { key: "main", flavour: "primary hero shot — product or service as the clear subject, uncluttered composition, strong focal point" },
  { key: "lifestyle", flavour: "lifestyle scene — real person benefiting from the service, natural lighting, candid feel" },
  { key: "bold-text", flavour: "headline-first poster — large bold typography with the headline copy as the dominant visual element" },
  { key: "testimonial", flavour: "social proof style — quote card or client photo with a pull-quote treatment" },
];

function buildDalleVariantPrompt(basePrompt, variant, copyText) {
  // DALL-E 3 hard-limits prompts to ~4000 chars; keep comfortable.
  const core = `${basePrompt.substring(0, 700)} Variant: ${variant.flavour}.`;
  const copy = copyText ? ` Headline to visualise: "${String(copyText).substring(0, 200)}"` : "";
  const guardrails = " Photorealistic or graphic-design quality as appropriate, commercial-ad polish, clear space for text overlay on one side.";
  return `${core}${copy}${guardrails}`.substring(0, 3800);
}

async function generateWithDallE(prompt, style = "vivid") {
  if (!OPENAI_API_KEY) return { error: "OPENAI_API_KEY not set", url: null };
  try {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "dall-e-3",
        prompt,
        n: 1,
        size: "1024x1024",
        quality: "standard",
        style,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { error: `DALL-E ${res.status}: ${txt.substring(0, 220)}`, url: null };
    }
    const data = await res.json();
    const url = data?.data?.[0]?.url || null;
    return { url, revised: data?.data?.[0]?.revised_prompt || null };
  } catch (e) { return { error: e.message, url: null }; }
}

async function generateDalleVariants(basePrompt, copyText) {
  const urls = [];
  const perVariantErrors = [];
  const revisedPrompts = [];
  for (const v of VARIANT_STYLES) {
    const prompt = buildDalleVariantPrompt(basePrompt, v, copyText);
    const style = v.key === "lifestyle" ? "natural" : "vivid";
    const { url, error, revised } = await generateWithDallE(prompt, style);
    if (url) { urls.push(url); revisedPrompts.push(revised); }
    else { perVariantErrors.push(`${v.key}: ${error}`); }
  }
  return {
    images: urls,
    error: urls.length === 0 ? perVariantErrors.join(" | ") : null,
    revisedPrompts,
  };
}

async function callHiggsfield(prompt) {
  if (!HIGGSFIELD_API_KEY) return { error: "HIGGSFIELD_API_KEY not set", images: [] };
  const body = {
    prompt,
    num_images: VARIANTS_PER_REQUEST,
    aspect_ratio: "1:1",
    model: "higgsfield-image-v1",
  };

  // Fast path: reuse the last working endpoint/auth pair.
  if (CACHED_HIGGSFIELD) {
    try {
      const { url, init } = buildHiggsfieldRequest(CACHED_HIGGSFIELD.endpoint, CACHED_HIGGSFIELD.strategy, body);
      const res = await fetch(url, init);
      if (res.ok) {
        const data = await res.json();
        return { images: parseHiggsfieldImages(data), strategy: CACHED_HIGGSFIELD.strategy.label, endpoint: CACHED_HIGGSFIELD.endpoint };
      }
      // 401 again — cache went stale, fall through to probing.
      if (res.status === 401) CACHED_HIGGSFIELD = null;
      else {
        const txt = await res.text();
        return { error: `Higgsfield ${res.status} (${CACHED_HIGGSFIELD.strategy.label}): ${txt.substring(0, 200)}`, images: [] };
      }
    } catch (e) {
      CACHED_HIGGSFIELD = null;
    }
  }

  const strategies = higgsfieldAuthStrategies();
  const attempts = [];
  for (const endpoint of HIGGSFIELD_CANDIDATE_ENDPOINTS) {
    for (const strategy of strategies) {
      try {
        const { url, init } = buildHiggsfieldRequest(endpoint, strategy, body);
        const res = await fetch(url, init);
        if (res.ok) {
          const data = await res.json();
          CACHED_HIGGSFIELD = { endpoint, strategy };
          console.log(`[ADGEN] Higgsfield auth ✓ — ${strategy.label} @ ${endpoint}`);
          return { images: parseHiggsfieldImages(data), strategy: strategy.label, endpoint };
        }
        const txt = await res.text();
        attempts.push(`${strategy.label}@${endpoint.replace(/https?:\/\//, "")}: ${res.status}`);
        // Non-auth errors (e.g. 400 bad prompt, 5xx) mean the auth was
        // accepted — surface that error immediately rather than
        // continuing to probe other strategies.
        if (res.status !== 401 && res.status !== 403 && res.status !== 404) {
          return { error: `Higgsfield ${res.status} (${strategy.label}): ${txt.substring(0, 200)}`, images: [] };
        }
      } catch (e) {
        attempts.push(`${strategy.label}@${endpoint}: ${e.message}`);
      }
    }
  }
  return { error: `Higgsfield auth failed — tried: ${attempts.join(" | ").substring(0, 400)}`, images: [] };
}

async function downloadImage(url, outPath) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outPath, buf);
    return true;
  } catch { return false; }
}

async function postToDiscord(creative) {
  if (!DISCORD_WEBHOOK) return;
  const embeds = (creative.imageUrls || []).slice(0, 4).map((url, i) => ({
    title: i === 0 ? `🎨 ADGEN — New Creative Batch` : undefined,
    description: i === 0
      ? `Niche: **${creative.niche}** · ID: \`${creative.id}\`\n**Copy:** ${creative.copyText?.substring(0, 300) || "—"}`
      : undefined,
    color: 0xFB923C,
    image: { url },
    footer: i === 0 ? { text: "ECHO GROWTH · AGENT HQ — ADGEN · Review before publishing" } : undefined,
    timestamp: i === 0 ? new Date().toISOString() : undefined,
  }));

  if (embeds.length === 0) {
    embeds.push({
      title: "🎨 ADGEN — Generation Pending",
      description: `No images returned${creative.generationError ? ` (${creative.generationError})` : ""}. ID: \`${creative.id}\``,
      color: 0xEF4444,
    });
  }

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ADGEN Agent", embeds }),
    });
  } catch (e) { console.error("[ADGEN] Discord failed:", e.message); }
}

export async function generateAds(input = {}) {
  const niche = input.niche || "B2B service businesses";
  const offer = input.offer || "Echo Growth lead-gen system ($8k, 90-day engagement)";
  const audience = input.audience || "founders aged 30-55";
  const copyText = input.copyText || "";
  const style = input.style || null;

  // Pull real performance signal so the prompt reflects what's actually working
  const perf = getLatestPerformance();
  const top = getTopCampaigns("ctr", 2);
  const creativeDirection = input.creativeDirection
    || (perf ? `Echo what's working: top CTR ${top[0]?.ctr || 0}% — angle: "${top[0]?.campaign || "—"}"` : "No live performance signal");

  const { key: templateKey, template } = chooseTemplate(niche);
  const prompt = await buildPrompt({
    niche, offer, audience, copyText,
    style: style || creativeDirection,
    template,
  });

  // Higgsfield first; DALL-E 3 as fallback when it returns zero images.
  let generator = "higgsfield";
  let { images, error, strategy: authStrategy } = await callHiggsfield(prompt);
  if (!images || images.length === 0) {
    console.warn(`[ADGEN] Higgsfield produced no images — falling back to DALL-E 3. Reason: ${error || "empty"}`);
    const dalle = await generateDalleVariants(prompt, copyText);
    if (dalle.images.length > 0) {
      images = dalle.images;
      generator = "dalle-3";
      error = null;
    } else {
      error = error
        ? `higgsfield: ${error} | dalle: ${dalle.error}`
        : `dalle: ${dalle.error}`;
    }
  }

  // Persist one creative record per batch (N images)
  const folderId = `creative_${Date.now()}`;
  const folder = path.join(imagesDir, folderId);
  if (images.length > 0 && !fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  const imagePaths = [];
  for (let i = 0; i < images.length; i++) {
    const ext = (images[i].match(/\.(png|jpg|jpeg|webp)(\?|$)/i)?.[1] || "png").toLowerCase();
    const p = path.join(folder, `variant-${i + 1}.${ext}`);
    const ok = await downloadImage(images[i], p);
    if (ok) imagePaths.push(p);
  }

  const creative = addCreative({
    agent: "ADGEN",
    niche, offer, audience, copyText,
    prompt,
    imageUrls: images,
    imagePaths,
    style,
    template: { key: templateKey, ...(template || {}) },
    notes: error
      ? `Generation warning (${generator}): ${error}`
      : `generator: ${generator}${authStrategy ? ` · auth: ${authStrategy}` : ""}`,
  });
  if (error) creative.generationError = error;

  await addToReview("ADGEN", "creative", {
    creativeId: creative.id,
    niche, copyText, prompt,
    template: templateKey,
    imageUrls: images,
    variantCount: images.length,
  });

  await postToDiscord(creative);
  await logActivity("ADGEN", images.length > 0 ? "images generated" : "generation failed",
    `${niche} · tpl:${templateKey} · gen:${generator} · ${images.length}/${VARIANTS_PER_REQUEST} variants${error ? ` (${error})` : ""}`);

  return { creative, error, template: templateKey, generator };
}

// No cron — ADGEN is triggered by COPY approvals or on-demand via /api/adgen/generate.
const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  console.log("[ADGEN Agent] Started — triggered on demand (no schedule)");
  console.log(`[ADGEN] Higgsfield endpoints: ${HIGGSFIELD_CANDIDATE_ENDPOINTS.join(", ")}`);
  console.log(`[ADGEN] Key: ${HIGGSFIELD_API_KEY ? "✓" : "✗"} · Secret: ${HIGGSFIELD_API_SECRET ? "✓" : "(key-only)"}`);
  const tplCount = Object.keys(loadTemplates().templates || {}).length;
  console.log(`[ADGEN] Templates loaded: ${tplCount}`);
  // Keep the process alive so the launcher doesn't loop-restart it.
  setInterval(() => {}, 1 << 30);
}
