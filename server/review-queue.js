// Central review queue. Any agent that produces human-review-required
// output calls addToReview(...) and the frontend's Review tab reads here.
// Items live in one JSON file — pending and history in the same array,
// separated by `status`. Nothing is ever deleted; rejected items stay
// so future agents can learn from the feedback.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const QUEUE_PATH = path.join(DATA_DIR, "review-queue.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(QUEUE_PATH)) fs.writeFileSync(QUEUE_PATH, "[]");
}
function readAll() { try { return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")); } catch { return []; } }
function writeAll(d) { fs.writeFileSync(QUEUE_PATH, JSON.stringify(d, null, 2)); }

export function addToReview(agent, type, content, meta = {}) {
  ensureFile();
  const all = readAll();
  const item = {
    id: `rq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    agent,
    type,
    content,
    meta,
    status: "pending",
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    feedback: null,
  };
  all.unshift(item);
  writeAll(all.slice(0, 500));
  return item;
}

export function listPending() {
  ensureFile();
  return readAll().filter(i => i.status === "pending");
}

export function listHistory(limit = 100) {
  ensureFile();
  return readAll().filter(i => i.status !== "pending").slice(0, limit);
}

export function getItem(id) {
  ensureFile();
  return readAll().find(i => i.id === id) || null;
}

function decide(id, status, feedback) {
  ensureFile();
  const all = readAll();
  const idx = all.findIndex(i => i.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], status, reviewedAt: new Date().toISOString(), feedback: feedback || null };
  writeAll(all);
  return all[idx];
}

export function approveItem(id, feedback = "") { return decide(id, "approved", feedback); }
export function rejectItem(id, feedback = "")  { return decide(id, "rejected", feedback); }

export function stats() {
  ensureFile();
  const all = readAll();
  const pending = all.filter(i => i.status === "pending").length;
  const approved = all.filter(i => i.status === "approved").length;
  const rejected = all.filter(i => i.status === "rejected").length;
  const total = pending + approved + rejected;
  return {
    pending,
    approved,
    rejected,
    total,
    approvalRate: (approved + rejected) > 0 ? Math.round((approved / (approved + rejected)) * 100) : 0,
  };
}
