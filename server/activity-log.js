// Shared activity log — DASH holds the buffer in-memory; other agents POST to it.
// Mirrors the existing "each agent is self-contained" pattern: import this module,
// call logActivity(...), and the caller doesn't need to know where DASH lives.

const DASH_API = process.env.DASH_API || "https://echo-growth-agent-hq-production.up.railway.app";
const MAX_ENTRIES = 200;

const AGENT_COLORS = {
  DASH: "#34D399",
  CSM: "#5865F2",
  FLUP: "#60A5FA",
  AUTO: "#00C2D4",
  OPS: "#2DD4BF",
  CMMS: "#F472B6",
  COPY: "#A78BFA",
  CRTV: "#FB923C",
  STRT: "#E879F9",
  FUNL: "#FBBF24",
  ADLIB: "#FF6B35",
  META: "#FF6B35",
};

// In-process buffer. Only DASH ever reads from it.
const buffer = [];

export function pushActivity(entry) {
  const normalised = {
    timestamp: entry.timestamp || new Date().toISOString(),
    agent: entry.agent || "UNKNOWN",
    action: entry.action || "activity",
    details: entry.details || "",
    color: entry.color || AGENT_COLORS[entry.agent] || "#888",
  };
  buffer.unshift(normalised);
  if (buffer.length > MAX_ENTRIES) buffer.length = MAX_ENTRIES;
  return normalised;
}

export function getActivity(limit = 100) {
  return buffer.slice(0, limit);
}

// Agents call this. If IS_DASH=1, write locally; otherwise POST to DASH.
export async function logActivity(agent, action, details = "") {
  const entry = {
    timestamp: new Date().toISOString(),
    agent,
    action,
    details,
    color: AGENT_COLORS[agent] || "#888",
  };

  if (process.env.IS_DASH === "1") {
    pushActivity(entry);
    return;
  }

  try {
    await fetch(`${DASH_API}/api/agents/activity/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    // Activity logging must never break an agent — swallow failures.
  }
}
