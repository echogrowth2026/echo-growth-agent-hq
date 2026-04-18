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
// Endpoint is env-configurable because Higgsfield's public API shape is
// still changing. Default is a best-guess REST path; override via
// HIGGSFIELD_ENDPOINT once the real one is confirmed.
const HIGGSFIELD_ENDPOINT = process.env.HIGGSFIELD_ENDPOINT || "https://platform.higgsfield.ai/v1/generations";
const DISCORD_WEBHOOK = process.env.ADGEN_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VARIANTS_PER_REQUEST = 4;

async function buildPrompt({ niche, offer, audience, copyText, style }) {
  // Use OpenAI to produce a good image prompt from the ad copy context.
  // If OpenAI isn't available, fall back to a deterministic template.
  const fallback = `Professional Meta ad creative for ${niche || "B2B service businesses"}. ${style || "Bright, clean, high-contrast, modern, commercial photography. Product/founder-forward. Readable text overlay space top-right."} Offer: ${offer || ""}. Headline vibe: ${copyText || ""}.`;
  if (!OPENAI_API_KEY) return fallback;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 200,
        messages: [
          { role: "system", content: "Produce one Higgsfield-style image generation prompt (under 80 words) for a Meta ad creative. Be specific about subject, lighting, composition, mood, and copy-overlay space. No disclaimers, no 'Sure, here is' prefixes." },
          { role: "user", content: `Niche: ${niche}\nOffer: ${offer || ""}\nAudience: ${audience || ""}\nCopy: ${copyText || ""}\nStyle note: ${style || ""}` },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || fallback;
  } catch { return fallback; }
}

async function callHiggsfield(prompt) {
  if (!HIGGSFIELD_API_KEY) return { error: "HIGGSFIELD_API_KEY not set", images: [] };
  try {
    const res = await fetch(HIGGSFIELD_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HIGGSFIELD_API_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        num_images: VARIANTS_PER_REQUEST,
        aspect_ratio: "1:1",
        model: "higgsfield-image-v1",
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { error: `Higgsfield ${res.status}: ${txt.substring(0, 200)}`, images: [] };
    }
    const data = await res.json();
    // Handle a few plausible response shapes
    const imgs =
      data.images?.map(i => i.url || i) ||
      data.data?.map(i => i.url || i) ||
      data.outputs?.map(i => i.url || i) ||
      [];
    return { images: imgs.filter(Boolean) };
  } catch (e) { return { error: e.message, images: [] }; }
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
  const offer = input.offer || "Echo Growth lead-gen system ($6k)";
  const audience = input.audience || "founders aged 30-55";
  const copyText = input.copyText || "";
  const style = input.style || null;

  // Pull real performance signal so the prompt reflects what's actually working
  const perf = getLatestPerformance();
  const top = getTopCampaigns("ctr", 2);
  const creativeDirection = input.creativeDirection
    || (perf ? `Echo what's working: top CTR ${top[0]?.ctr || 0}% — angle: "${top[0]?.campaign || "—"}"` : "No live performance signal");

  const prompt = await buildPrompt({ niche, offer, audience, copyText, style: style || creativeDirection });
  const { images, error } = await callHiggsfield(prompt);

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
    notes: error ? `Generation warning: ${error}` : "",
  });
  if (error) creative.generationError = error;

  await addToReview("ADGEN", "creative", {
    creativeId: creative.id,
    niche, copyText, prompt,
    imageUrls: images,
    variantCount: images.length,
  });

  await postToDiscord(creative);
  await logActivity("ADGEN", images.length > 0 ? "images generated" : "generation failed",
    `${niche} · ${images.length}/${VARIANTS_PER_REQUEST} variants${error ? ` (${error})` : ""}`);

  return { creative, error };
}

// No cron — ADGEN is triggered by COPY approvals or on-demand via /api/adgen/generate.
const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  console.log("[ADGEN Agent] Started — triggered on demand (no schedule)");
  console.log(`[ADGEN] Higgsfield endpoint: ${HIGGSFIELD_ENDPOINT}`);
  console.log(`[ADGEN] Key configured: ${HIGGSFIELD_API_KEY ? "✓" : "✗"}`);
  // Keep the process alive so the launcher doesn't loop-restart it.
  setInterval(() => {}, 1 << 30);
}
