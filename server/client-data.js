// server/client-data.js
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const KB_DIR = path.join(__dirname, "kb");

export async function getClientKB(clientSlug) {
  try {
    const file = path.join(KB_DIR, `${clientSlug}.json`);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    console.error(`[client-data] getClientKB(${clientSlug}) failed:`, err.message);
    return null;
  }
}

export async function listClients() {
  try {
    await fs.mkdir(KB_DIR, { recursive: true });
    const files = await fs.readdir(KB_DIR);
    return files
      .filter(f => f.endsWith(".json") && !f.startsWith("_"))
      .map(f => f.replace(".json", ""));
  } catch (err) {
    console.error("[client-data] listClients failed:", err.message);
    return [];
  }
}

export async function resolveClient(query) {
  const slugs = await listClients();
  const q = query.toLowerCase().trim();
  if (slugs.includes(q)) return q;
  const hyphenated = q.replace(/\s+/g, "-");
  if (slugs.includes(hyphenated)) return hyphenated;
  const contains = slugs.find(s => s.includes(hyphenated) || hyphenated.includes(s));
  if (contains) return contains;
  for (const slug of slugs) {
    const kb = await getClientKB(slug);
    if (kb?.client?.name?.toLowerCase().includes(q)) return slug;
  }
  return null;
}

export async function getClientChannelId(clientSlug) {
  const kb = await getClientKB(clientSlug);
  return kb?.client?.discord_channel_id || null;
}

export async function getClientByChannelId(channelId) {
  // Match against the registry first so every registered client is "monitored"
  // even before their KB file exists. Caller decides what to do when kb is null.
  const reg = await getRegistry();
  const entry = (reg.clients || []).find(c => c.discord_channel_id === channelId);
  if (entry) {
    const kb = await getClientKB(entry.slug);
    return { slug: entry.slug, kb, registry: entry };
  }
  // Fall back to KB-file scan for any clients seeded without a registry entry.
  const slugs = await listClients();
  for (const slug of slugs) {
    const kb = await getClientKB(slug);
    if (kb?.client?.discord_channel_id === channelId) return { slug, kb, registry: null };
  }
  return null;
}

export async function getRegistry() {
  try {
    const file = path.join(KB_DIR, "_clients.json");
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return { clients: [] };
  }
}

export default {
  getClientKB,
  listClients,
  resolveClient,
  getClientChannelId,
  getClientByChannelId,
  getRegistry,
  KB_DIR
};
