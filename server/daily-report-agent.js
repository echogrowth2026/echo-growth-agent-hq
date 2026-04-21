// server/daily-report-agent.js
// Posts two daily Discord embeds at 21:00 Europe/London:
//   - calls report to CHANNEL_DAILY_CALLS
//   - revenue report to CHANNEL_DAILY_PAYMENTS
// Counts are derived from messages posted in each channel during the
// trailing 24h. Revenue amounts are parsed from message content ($ or £).
// Meta context is pulled from server/kb/echo-growth.json raw.meta.
// NOT gated by SILENCED_AGENTS — this agent always posts.
import fs from "fs/promises";
import path from "path";
import cron from "node-cron";
import dotenv from "dotenv";
import { Client as DiscordClient, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHANNEL_DAILY_CALLS = process.env.CHANNEL_DAILY_CALLS || "1362025450615996447";
const CHANNEL_DAILY_PAYMENTS = process.env.CHANNEL_DAILY_PAYMENTS || "1435787116318687262";
const KB_PATH = path.join(__dirname, "kb", "echo-growth.json");
const WINDOW_MS = 24 * 60 * 60 * 1000;

// ─── FETCH LAST 24h OF MESSAGES FROM A CHANNEL ──────────────────────
async function fetchMessagesLast24h(discord, channelId) {
  try {
    const channel = await discord.channels.fetch(channelId);
    if (!channel?.isTextBased()) return { ok: false, reason: "not text channel" };

    const cutoff = Date.now() - WINDOW_MS;
    const messages = [];
    let lastId;
    for (let i = 0; i < 10; i++) {
      const batch = await channel.messages.fetch({ limit: 100, before: lastId });
      if (batch.size === 0) break;
      let hitCutoff = false;
      for (const msg of batch.values()) {
        if (msg.author.bot) continue;
        if (msg.createdTimestamp < cutoff) { hitCutoff = true; break; }
        messages.push({ content: msg.content, ts: msg.createdTimestamp });
      }
      if (hitCutoff) break;
      lastId = batch.last()?.id;
    }
    return { ok: true, messages, channel };
  } catch (err) {
    console.error(`[DAILY-REPORT] fetch failed for ${channelId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// ─── PAYMENT AMOUNT EXTRACTION ──────────────────────────────────────
function extractAmounts(content) {
  const out = { usd: 0, gbp: 0, hasAmount: false };
  const usd = /\$([\d,]+(?:\.\d{1,2})?)/g;
  const gbp = /£([\d,]+(?:\.\d{1,2})?)/g;
  let m;
  while ((m = usd.exec(content)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(n)) { out.usd += n; out.hasAmount = true; }
  }
  while ((m = gbp.exec(content)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(n)) { out.gbp += n; out.hasAmount = true; }
  }
  return out;
}

// ─── KB META CONTEXT ────────────────────────────────────────────────
async function loadMeta() {
  try {
    const kb = JSON.parse(await fs.readFile(KB_PATH, "utf8"));
    return kb?.raw?.meta || null;
  } catch {
    return null;
  }
}

function formatMetaContext(meta) {
  if (!meta) return "";
  const parts = [];
  if (meta.leads != null) parts.push(`${meta.leads} ${meta.result_type || "website schedules"}`);
  if (meta.cpl != null) parts.push(`at £${meta.cpl} CPR`);
  if (meta.daily_spend != null) parts.push(`daily spend £${meta.daily_spend}`);
  if (meta.total_spend != null) parts.push(`total spend £${meta.total_spend.toLocaleString()}`);
  if (meta.reach != null) parts.push(`${meta.reach.toLocaleString()} reach`);
  if (meta.impressions != null) parts.push(`${meta.impressions.toLocaleString()} impressions`);
  if (meta.ctr != null) parts.push(`${meta.ctr}% CTR`);
  if (meta.cpm != null) parts.push(`£${meta.cpm} CPM`);
  if (meta.clicks != null) parts.push(`${meta.clicks.toLocaleString()} clicks`);
  if (parts.length === 0) return "";
  return ` With our current Meta performance (${parts.join(", ")}) — we're on a strong trajectory.`;
}

// ─── MAIN RUN ───────────────────────────────────────────────────────
export async function runDailyReport() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn("[DAILY-REPORT] DISCORD_BOT_TOKEN missing — cannot post");
    return { ok: false, reason: "no token" };
  }

  console.log(`[DAILY-REPORT] Run started ${new Date().toISOString()}`);

  const discord = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  await discord.login(token);

  const meta = await loadMeta();
  const metaContext = formatMetaContext(meta);

  // ── Calls report ──
  const calls = await fetchMessagesLast24h(discord, CHANNEL_DAILY_CALLS);
  if (calls.ok) {
    const count = calls.messages.length;
    const embed = new EmbedBuilder()
      .setTitle("📞 Daily Calls Report")
      .setColor(0x34D399)
      .setDescription(`Today we booked **${count}** call${count === 1 ? "" : "s"}.${metaContext}`)
      .setTimestamp(new Date());
    try {
      await calls.channel.send({ embeds: [embed] });
      console.log(`[DAILY-REPORT] Calls posted — ${count} bookings`);
    } catch (err) {
      console.error("[DAILY-REPORT] Calls send failed:", err.message);
    }
  } else {
    console.error(`[DAILY-REPORT] Calls channel unavailable: ${calls.reason || calls.error}`);
  }

  // ── Payments report ──
  const pays = await fetchMessagesLast24h(discord, CHANNEL_DAILY_PAYMENTS);
  if (pays.ok) {
    let totalUsd = 0, totalGbp = 0, paymentCount = 0;
    for (const m of pays.messages) {
      const a = extractAmounts(m.content);
      if (a.hasAmount) {
        totalUsd += a.usd;
        totalGbp += a.gbp;
        paymentCount += 1;
      }
    }
    const msgCount = pays.messages.length;
    const totalParts = [];
    if (totalUsd > 0) totalParts.push(`$${totalUsd.toLocaleString()}`);
    if (totalGbp > 0) totalParts.push(`£${totalGbp.toLocaleString()}`);
    const totalStr = totalParts.length ? totalParts.join(" + ") : "no amounts detected";
    const reportedCount = paymentCount || msgCount;
    const desc = `Today we collected a total of **${totalStr}** across **${reportedCount}** payment${reportedCount === 1 ? "" : "s"}.${metaContext}`;
    const embed = new EmbedBuilder()
      .setTitle("💰 Daily Revenue Report")
      .setColor(0xFBBF24)
      .setDescription(desc)
      .setTimestamp(new Date());
    try {
      await pays.channel.send({ embeds: [embed] });
      console.log(`[DAILY-REPORT] Payments posted — ${paymentCount} with amounts · $${totalUsd} + £${totalGbp}`);
    } catch (err) {
      console.error("[DAILY-REPORT] Payments send failed:", err.message);
    }
  } else {
    console.error(`[DAILY-REPORT] Payments channel unavailable: ${pays.reason || pays.error}`);
  }

  await discord.destroy();
  console.log("[DAILY-REPORT] Run complete");
  return { ok: true };
}

// ─── SCHEDULE — daily 21:00 Europe/London ───────────────────────────
// Guarded with isMain so importing from DASH (for future manual trigger)
// doesn't double-schedule. NOT affected by SILENCED_AGENTS.
const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "");
if (isMain) {
  cron.schedule("0 21 * * *", runDailyReport, { timezone: "Europe/London" });
  console.log("[DAILY-REPORT] Agent started — daily 21:00 Europe/London report scheduled");
}
