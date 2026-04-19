// Echo Ad Library — central storage for every creative we generate or
// approve. Persists to JSON so it survives process restarts. Designed
// to be upgraded to Postgres later without changing the interface.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const LIBRARY_PATH = path.join(DATA_DIR, "ad-library.json");
const IMAGES_DIR = path.join(DATA_DIR, "ad-library");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
  if (!fs.existsSync(LIBRARY_PATH)) fs.writeFileSync(LIBRARY_PATH, "[]");
}
function readAll() { try { return JSON.parse(fs.readFileSync(LIBRARY_PATH, "utf8")); } catch { return []; } }
function writeAll(d) { fs.writeFileSync(LIBRARY_PATH, JSON.stringify(d, null, 2)); }

export const imagesDir = IMAGES_DIR;

export function addCreative({ agent, niche, offer, audience, copyText, prompt, imageUrls = [], imagePaths = [], style = null, template = null, notes = "" }) {
  ensure();
  const all = readAll();
  const item = {
    id: `creative_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    agent: agent || "ADGEN",
    niche: niche || null,
    offer: offer || null,
    audience: audience || null,
    copyText: copyText || null,
    prompt: prompt || null,
    imageUrls,     // remote URLs returned by the generator
    imagePaths,    // local paths if we downloaded the images
    style: style,
    template,      // { key, style, colours, composition, promptBase } or null
    status: "pending",
    notes,
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    feedback: null,
    performance: null, // filled in later when linked to real ad data
  };
  all.unshift(item);
  writeAll(all.slice(0, 2000));
  return item;
}

export function list({ status = null, niche = null, from = null, to = null, limit = 200 } = {}) {
  ensure();
  let items = readAll();
  if (status) items = items.filter(i => i.status === status);
  if (niche)  items = items.filter(i => (i.niche || "").toLowerCase().includes(niche.toLowerCase()));
  if (from)   items = items.filter(i => new Date(i.createdAt) >= new Date(from));
  if (to)     items = items.filter(i => new Date(i.createdAt) <= new Date(to));
  return items.slice(0, limit);
}

export function getCreative(id) {
  ensure();
  return readAll().find(i => i.id === id) || null;
}

function decide(id, status, feedback) {
  ensure();
  const all = readAll();
  const idx = all.findIndex(i => i.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], status, reviewedAt: new Date().toISOString(), feedback: feedback || null };
  writeAll(all);
  return all[idx];
}

export function approveCreative(id, feedback = "") { return decide(id, "approved", feedback); }
export function rejectCreative(id, feedback = "")  { return decide(id, "rejected", feedback); }

export function attachPerformance(id, performance) {
  ensure();
  const all = readAll();
  const idx = all.findIndex(i => i.id === id);
  if (idx === -1) return null;
  all[idx].performance = performance;
  writeAll(all);
  return all[idx];
}

export function stats() {
  ensure();
  const all = readAll();
  const byStatus = { pending: 0, approved: 0, rejected: 0 };
  const byNiche = {};
  for (const i of all) {
    byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    if (i.niche) byNiche[i.niche] = (byNiche[i.niche] || 0) + 1;
  }
  const decided = byStatus.approved + byStatus.rejected;
  return {
    total: all.length,
    byStatus,
    byNiche,
    approvalRate: decided > 0 ? Math.round((byStatus.approved / decided) * 100) : 0,
  };
}
