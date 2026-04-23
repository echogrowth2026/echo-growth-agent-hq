// server/csm-morning-brief.js
// Daily 9am (Europe/London) brief per client. Logs into Discord with the
// CSM bot token, posts a KB-derived embed to each client's channel, then
// destroys the connection. Scaffold — content is derived from the KB
// summary fields written by csm-kb-refresh (Brief C). Will be tuned when
// the upstream data brief arrives.
//
// Respects SILENCED_AGENTS=BRIEF to disable posting without code changes.
import fs from "fs/promises";
import path from "path";
import cron from "node-cron";
import dotenv from "dotenv";
import { Client as DiscordClient, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { getClientKB, getRegistry } from "./client-data.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const SILENCED = (process.env.SILENCED_AGENTS || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

const SENTIMENT_COLOR = {
  positive: 0x34D399,
  neutral: 0x94A3B8,
  concerned: 0xFBBF24,
  frustrated: 0xEF4444,
};

function buildEmbed(kb, clientEntry) {
  const s = kb.summary || {};
  const sentiment = (s.sentiment || "neutral").toLowerCase();
  const color = SENTIMENT_COLOR[sentiment] ?? SENTIMENT_COLOR.neutral;

  const themes = Array.isArray(s.themes) && s.themes.length
    ? s.themes.slice(0, 5).map(t => `• ${t}`).join("\n")
    : "_No recent themes captured in KB._";

  const talking = Array.isArray(s.talking_points) && s.talking_points.length
    ? s.talking_points.slice(0, 5).map(t => `• ${t}`).join("\n")
    : "_No talking points in KB yet._";

  const meta = kb.raw?.meta || null;
  const adLines = meta ? [
    meta.spend != null && `Spend: £${meta.spend}`,
    meta.leads != null && `Leads: ${meta.leads}`,
    meta.cpl != null && `CPL: £${meta.cpl}`,
    meta.ctr != null && `CTR: ${meta.ctr}%`,
    meta.top_campaign && `Top campaign: ${meta.top_campaign}`,
    Array.isArray(meta.fatigue_risks) && meta.fatigue_risks.length
      ? `Fatigue risks: ${meta.fatigue_risks.map(f => f.creative || f).join(", ")}`
      : null,
  ].filter(Boolean).join("\n") : null;

  const title = clientEntry?.name || kb.slug || "client";
  const embed = new EmbedBuilder()
    .setTitle(`☀️ Morning brief — ${title}`)
    .setColor(color)
    .setDescription(s.headline || "_No headline in KB yet._")
    .setTimestamp(new Date())
    .setFooter({ text: `Echo Growth · CSM · sentiment: ${sentiment}` });

  embed.addFields(
    { name: "🎯 Talking points", value: talking, inline: false },
    { name: "💬 Themes", value: themes, inline: false },
  );

  if (adLines) embed.addFields({ name: "📊 Ad performance", value: adLines, inline: false });

  return embed;
}

async function postForClient(discord, clientEntry) {
  const slug = clientEntry.slug;
  const channelId = clientEntry.discord_channel_id;

  if (!channelId) {
    console.log(`[BRIEF] ${slug} — skip (no discord_channel_id)`);
    return { slug, ok: false, reason: "no channel_id" };
  }

  // Hard rule: no morning brief for clients without a connected Meta ad account.
  // Without live ad data the performance block would be fabricated, so we stay silent.
  if (!clientEntry.meta_ad_account_id) {
    console.log(`[BRIEF] ${slug} — skip (no meta_ad_account_id)`);
    return { slug, ok: false, reason: "no ad account" };
  }

  const kb = await getClientKB(slug);
  if (!kb?.summary) {
    console.log(`[BRIEF] ${slug} — skip (no KB summary)`);
    return { slug, ok: false, reason: "no kb" };
  }

  try {
    const channel = await discord.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      console.log(`[BRIEF] ${slug} — skip (channel ${channelId} not text)`);
      return { slug, ok: false, reason: "not text channel" };
    }
    const embed = buildEmbed(kb, clientEntry);
    await channel.send({ embeds: [embed] });
    console.log(`[BRIEF] ${slug} — posted ✓`);
    return { slug, ok: true };
  } catch (err) {
    console.error(`[BRIEF] ${slug} — post failed:`, err.message);
    return { slug, ok: false, reason: err.message };
  }
}

export async function runMorningBrief() {
  if (SILENCED.includes("BRIEF")) {
    console.log("[BRIEF] Run silenced (SILENCED_AGENTS env)");
    return { silenced: true };
  }

  const registry = await getRegistry();
  const clients = registry.clients || [];
  if (clients.length === 0) {
    console.log("[BRIEF] No clients in registry — skipping");
    return { ok: true, posted: 0 };
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn("[BRIEF] DISCORD_BOT_TOKEN missing — cannot post");
    return { ok: false, reason: "no token" };
  }

  const discord = new DiscordClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
  await discord.login(token);

  const results = [];
  for (const c of clients) {
    results.push(await postForClient(discord, c));
  }

  await discord.destroy();

  const ok = results.filter(r => r.ok).length;
  console.log(`[BRIEF] Run complete — ${ok}/${results.length} posted`);
  return { ok: true, posted: ok, total: results.length, results };
}

// ─── SCHEDULE — every day at 09:00 Europe/London ────────────────────
// Guarded so importing this module into DASH doesn't double-schedule.
const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  cron.schedule("0 9 * * *", runMorningBrief, { timezone: "Europe/London" });
  console.log("[BRIEF] Agent started — daily 09:00 Europe/London brief scheduled");
}
