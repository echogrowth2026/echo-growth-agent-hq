// server/discord-post.js
// Shared Discord webhook poster. Silences any agent listed in SILENCED_AGENTS
// (comma-separated, e.g. "DASH,CMMS,AUTO,FLUP"). Env var is read at import
// time — toggle by editing Railway env + restart, per the brief.

const SILENCED = (process.env.SILENCED_AGENTS || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

export async function postToDiscord(agentName, payload, webhookUrl = process.env.DISCORD_WEBHOOK) {
  const agent = (agentName || "").toUpperCase();
  if (SILENCED.includes(agent)) {
    console.log(`[${agent}] Discord post silenced (SILENCED_AGENTS env)`);
    return { silenced: true };
  }
  if (!webhookUrl) {
    console.warn(`[${agent}] No Discord webhook configured`);
    return { silenced: false, error: "no webhook" };
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { silenced: false, ok: res.ok, status: res.status };
  } catch (err) {
    console.error(`[${agent}] Discord post failed:`, err.message);
    return { silenced: false, error: err.message };
  }
}

export default { postToDiscord };
