import { useState, useEffect, useCallback } from "react";

const DASH_API = "https://echo-growth-agent-hq-production.up.railway.app";

const ROOMS = [
  { id: "meta", name: "Meta Ads", x: 40, y: 40, w: 170, h: 110, color: "#FF6B35", icon: "📣" },
  { id: "ads", name: "Ad Copy", x: 230, y: 40, w: 170, h: 110, color: "#A78BFA", icon: "✍️" },
  { id: "creatives", name: "Ad Creatives", x: 420, y: 40, w: 170, h: 110, color: "#FB923C", icon: "🎨" },
  { id: "pipeline", name: "Pipeline Setup", x: 610, y: 40, w: 170, h: 110, color: "#00C2D4", icon: "⚙️" },
  { id: "leads", name: "Lead Room", x: 40, y: 210, w: 170, h: 110, color: "#34D399", icon: "📊" },
  { id: "followup", name: "Follow-Up", x: 230, y: 210, w: 170, h: 110, color: "#60A5FA", icon: "📞" },
  { id: "funnels", name: "Funnel Lab", x: 420, y: 210, w: 170, h: 110, color: "#FBBF24", icon: "🔧" },
  { id: "comms", name: "Client Comms", x: 610, y: 210, w: 170, h: 110, color: "#F472B6", icon: "💬" },
  { id: "strategy", name: "Strategy Room", x: 40, y: 380, w: 170, h: 110, color: "#E879F9", icon: "🧠" },
  { id: "ops", name: "Ops Deck", x: 230, y: 380, w: 170, h: 110, color: "#2DD4BF", icon: "🛠️" },
  { id: "csm", name: "CSM Suite", x: 420, y: 380, w: 170, h: 110, color: "#5865F2", icon: "🎮" },
];

const AGENT_DEFS = [
  { id: 1, name: "META", color: "#FF6B35", homeRoom: "meta", role: "Meta Ads Monitor", status: "planned" },
  { id: 2, name: "COPY", color: "#A78BFA", homeRoom: "ads", role: "Ad Copywriter", status: "live" },
  { id: 3, name: "AUTO", color: "#00C2D4", homeRoom: "pipeline", role: "GHL Automation", status: "live" },
  { id: 4, name: "FUNL", color: "#FBBF24", homeRoom: "funnels", role: "Funnel Auditor", status: "live" },
  { id: 5, name: "DASH", color: "#34D399", homeRoom: "leads", role: "Dashboard Intel", status: "live" },
  { id: 6, name: "FLUP", color: "#60A5FA", homeRoom: "followup", role: "Follow-Up Agent", status: "live" },
  { id: 7, name: "CRTV", color: "#FB923C", homeRoom: "creatives", role: "Creative Builder", status: "live" },
  { id: 8, name: "STRT", color: "#E879F9", homeRoom: "strategy", role: "Strategy Analyst", status: "live" },
  { id: 9, name: "OPS", color: "#2DD4BF", homeRoom: "ops", role: "Operations Agent", status: "live" },
  { id: 10, name: "CMMS", color: "#F472B6", homeRoom: "comms", role: "Client Comms", status: "live" },
  { id: 11, name: "CSM", color: "#5865F2", homeRoom: "csm", role: "Discord CSM", status: "live" },
  { id: 12, name: "ADLIB", color: "#FF6B35", homeRoom: "meta", role: "Ad Intelligence (read-only)", status: "live" },
  { id: 13, name: "ADGEN", color: "#F97316", homeRoom: "creatives", role: "Higgsfield Creative Gen", status: "live" },
  { id: 14, name: "ADSPY", color: "#8B5CF6", homeRoom: "strategy", role: "Competitor Intel", status: "live" },
];

const CORRIDORS = [
  { from: "meta", to: "ads" }, { from: "ads", to: "creatives" }, { from: "creatives", to: "pipeline" },
  { from: "leads", to: "followup" }, { from: "followup", to: "funnels" }, { from: "funnels", to: "comms" },
  { from: "meta", to: "leads" }, { from: "pipeline", to: "comms" }, { from: "strategy", to: "ops" },
  { from: "ops", to: "csm" }, { from: "funnels", to: "strategy" }, { from: "leads", to: "strategy" }, { from: "comms", to: "csm" },
];

function getRoomCenter(id) { const r = ROOMS.find(r => r.id === id); return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 350, y: 290 }; }

function useDashData() {
  const [d, setD] = useState(null);
  const f = useCallback(async () => { try { const r = await fetch(`${DASH_API}/api/dash`); if (r.ok) setD(await r.json()); } catch {} }, []);
  useEffect(() => { f(); const iv = setInterval(f, 60000); return () => clearInterval(iv); }, [f]);
  return d;
}

function useDiscordStats() {
  const [s, setS] = useState(null);
  const f = useCallback(async () => { try { const r = await fetch(`${DASH_API}/api/dash/discord-stats`); if (r.ok) setS(await r.json()); } catch {} }, []);
  useEffect(() => { f(); const iv = setInterval(f, 60000); return () => clearInterval(iv); }, [f]);
  return s;
}

function useAdStats() {
  const [s, setS] = useState(null);
  const f = useCallback(async () => { try { const r = await fetch(`${DASH_API}/api/dash/ad-stats`); if (r.ok) setS(await r.json()); } catch {} }, []);
  useEffect(() => { f(); const iv = setInterval(f, 5 * 60 * 1000); return () => clearInterval(iv); }, [f]);
  return s;
}

function useActivityFeed() {
  const [a, setA] = useState([]);
  const f = useCallback(async () => { try { const r = await fetch(`${DASH_API}/api/agents/activity?limit=80`); if (r.ok) { const d = await r.json(); setA(d.activity || []); } } catch {} }, []);
  useEffect(() => { f(); const iv = setInterval(f, 30000); return () => clearInterval(iv); }, [f]);
  return a;
}

function useReviewQueue() {
  const [pending, setPending] = useState([]);
  const f = useCallback(async () => {
    try {
      const r = await fetch(`${DASH_API}/api/review`);
      if (r.ok) { const d = await r.json(); setPending(d.pending || []); }
    } catch {}
  }, []);
  useEffect(() => { f(); const iv = setInterval(f, 30000); return () => clearInterval(iv); }, [f]);
  return { pending, refresh: f };
}

async function decideReview(id, action, feedback = "") {
  try {
    await fetch(`${DASH_API}/api/review/${id}/${action}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    });
  } catch {}
}

function AgentSprite({ agent }) {
  const live = AGENT_DEFS.find(a => a.name === agent.name)?.status === "live";
  return (<div style={{ position: "absolute", left: agent.x, top: agent.y, transform: "translate(-50%,-50%)", zIndex: 20, transition: "left 1.4s cubic-bezier(.45,0,.55,1),top 1.4s cubic-bezier(.45,0,.55,1)", pointerEvents: "none", opacity: live ? 1 : 0.3 }}>
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", bottom: -5, left: "50%", transform: "translateX(-50%)", width: 18, height: 5, borderRadius: "50%", background: "rgba(0,0,0,.5)", filter: "blur(2px)" }} />
      <div style={{ width: 22, height: 22, borderRadius: "50% 50% 38% 38%", background: `radial-gradient(circle at 35% 30%,${agent.color}ff,${agent.color}77)`, border: `2px solid ${agent.color}`, boxShadow: `0 0 12px ${agent.color}66`, display: "flex", alignItems: "center", justifyContent: "center", animation: live ? "bob .55s ease-in-out infinite alternate" : "none" }}>
        <div style={{ width: 9, height: 6, borderRadius: 3, background: "rgba(210,245,255,.9)", marginTop: -2 }} />
      </div>
      {agent.carrying && <div style={{ position: "absolute", top: 0, right: -10, fontSize: 8, animation: "pulse .7s ease infinite" }}>📦</div>}
      <div style={{ position: "absolute", top: 25, left: "50%", transform: "translateX(-50%)", fontSize: 7, color: agent.color, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, whiteSpace: "nowrap", textShadow: `0 0 8px ${agent.color}` }}>{agent.name}</div>
    </div>
  </div>);
}

function RoomPanel({ room, agents, dashData, onClose }) {
  const roomAgents = agents.filter(a => a.currentRoom === room.id);
  const defs = roomAgents.map(a => AGENT_DEFS.find(d => d.name === a.name)).filter(Boolean);
  const getFeed = () => {
    if (room.id === "leads" && dashData) return [
      `${dashData.leads?.total || 0} total contacts`, `${dashData.leads?.today || 0} new today`,
      `Show rate: ${dashData.bookings?.showRate || 0}%`, `${dashData.opportunities?.open || 0} open opps`,
      `${dashData.conversations?.unread || 0} unread convos`,
      ...(dashData.alerts || []).map(a => `${a.level === "warning" ? "⚠️" : "ℹ️"} ${a.message}`)
    ];
    if (room.id === "followup") return ["FLUP: 9am chase + 2pm recovery", "Sends SMS with booking link", "Enrolls in 14-day workflow", "Re-books no-shows", "Marks dead after 14 days"];
    if (room.id === "comms") return ["CMMS: 15-min inbox scans", `${dashData?.conversations?.unread || 0} unread`, "AI-drafts replies", "Escalates to Sam"];
    if (room.id === "ops") return ["OPS: 5-min health checks", "Auto-restarts crashed agents", "Daily 8am report"];
    if (room.id === "pipeline") return ["AUTO: hourly health checks", "Monitors pipelines + calendars", "Fixes conflicting tags", "Flags stuck contacts"];
    if (room.id === "csm") return ["CSM: Discord AI monitoring", "Intelligent triage", "Client lookup via GHL", "Monday check-ins", "Escalates to Sam DM"];
    return ["Agent coming soon"];
  };
  const feed = getFeed();

  return (<div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,.8)", backdropFilter: "blur(12px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
    <div style={{ background: "#0A0E14", border: `2px solid ${room.color}33`, borderRadius: 20, padding: 28, width: 540, boxShadow: `0 0 60px ${room.color}10`, maxHeight: "85vh", overflowY: "auto", animation: "panelIn .2s ease" }} onClick={e => e.stopPropagation()}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
        <div><span style={{ fontSize: 26 }}>{room.icon}</span><h2 style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 20, marginTop: 4 }}>{room.name}</h2>
          {room.id === "leads" && dashData && <div style={{ fontSize: 9, color: "#34D399", fontFamily: "'JetBrains Mono',monospace", marginTop: 4 }}>🟢 LIVE — {new Date(dashData.lastUpdated).toLocaleTimeString("en-GB")}</div>}
        </div>
        <button onClick={onClose} style={{ background: "none", border: "1px solid #222", color: "#555", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 11 }}>✕</button>
      </div>
      {room.id === "leads" && dashData && (<div style={{ background: "#34D3990A", border: "1px solid #34D39922", borderRadius: 14, padding: 16, marginBottom: 14, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
        {[{ l: "Total", v: dashData.leads?.total || 0, c: "#34D399" }, { l: "Today", v: dashData.leads?.today || 0, c: "#34D399" }, { l: "Open Opps", v: dashData.opportunities?.open || 0, c: "#FBBF24" }, { l: "Show %", v: `${dashData.bookings?.showRate || 0}%`, c: "#60A5FA" }].map((s, i) => (
          <div key={i} style={{ textAlign: "center" }}><div style={{ color: s.c, fontWeight: 800, fontSize: 20, fontFamily: "'Syne',sans-serif" }}>{s.v}</div><div style={{ color: "#444", fontSize: 8 }}>{s.l}</div></div>
        ))}
      </div>)}
      {defs.map(a => (<div key={a.id} style={{ background: a.color + "0C", border: `1px solid ${a.color}22`, borderRadius: 14, padding: "12px 16px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: a.color, boxShadow: `0 0 6px ${a.color}` }} />
        <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, color: a.color, fontSize: 14 }}>{a.name}</span>
        <span style={{ color: "#555", fontSize: 11 }}>{a.role}</span>
        <span style={{ marginLeft: "auto", fontSize: 8, padding: "2px 6px", borderRadius: 4, background: a.status === "live" ? "#34D39915" : "#fff08", color: a.status === "live" ? "#34D399" : "#444" }}>{a.status === "live" ? "LIVE" : "PLANNED"}</span>
      </div>))}
      <div style={{ background: "#060A0F", borderRadius: 12, padding: 16, border: "1px solid #111", marginTop: 4 }}>
        <div style={{ fontSize: 9, color: "#333", letterSpacing: ".15em", marginBottom: 10 }}>LIVE ACTIVITY</div>
        {feed.map((f, i) => (<div key={i} style={{ display: "flex", gap: 10, marginBottom: 6, opacity: 1 - i * .12 }}>
          <span style={{ fontSize: 11, color: i === 0 ? "#fff" : "#555", fontFamily: "'JetBrains Mono',monospace" }}>{i === 0 && <span style={{ color: room.color }}>▶ </span>}{f}</span>
        </div>))}
      </div>
    </div>
  </div>);
}

function MetricsBar({ dashData, discordStats, adStats }) {
  const perf = adStats?.performance;
  const items = [
    { l: "New Leads Today", v: discordStats?.today?.leads ?? 0, c: "#34D399" },
    { l: "Booked Calls Today", v: discordStats?.today?.calls ?? 0, c: "#60A5FA" },
    { l: "Revenue MTD", v: `£${(discordStats?.month?.paymentsAmount || 0).toLocaleString()}`, c: "#E879F9" },
    { l: "Ad Spend 7d", v: perf ? `£${(perf.totalSpend || 0).toLocaleString()}` : "—", c: "#FF6B35" },
    { l: "CPL", v: perf && perf.cpl ? `£${perf.cpl}` : "—", c: "#A78BFA" },
    { l: "CTR", v: perf ? `${perf.ctr || 0}%` : "—", c: "#FBBF24" },
    { l: "Pipeline Value", v: `£${(dashData?.opportunities?.totalValue || 0).toLocaleString()}`, c: "#FB923C" },
    { l: "Show Rate", v: `${dashData?.bookings?.showRate || 0}%`, c: "#2DD4BF" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: 10, padding: "10px 24px", background: "#05080C", borderBottom: "1px solid #0f0f0f", flexShrink: 0 }}>
      {items.map((i, idx) => (
        <div key={idx} style={{ background: "#0A0E14", border: `1px solid ${i.c}22`, borderRadius: 10, padding: "8px 12px", textAlign: "center" }}>
          <div style={{ color: i.c, fontWeight: 800, fontSize: 16, fontFamily: "'Syne',sans-serif" }}>{i.v}</div>
          <div style={{ color: "#444", fontSize: 8, marginTop: 2, letterSpacing: ".1em", textTransform: "uppercase" }}>{i.l}</div>
        </div>
      ))}
    </div>
  );
}

function LookupCard({ result }) {
  if (!result?.found) return <div style={{ color: "#F87171", fontSize: 11 }}>{result?.message || "Not found."}</div>;
  const c = result.contacts?.[0];
  if (!c) return null;
  return (
    <div style={{ fontSize: 12, color: "#ddd", lineHeight: 1.7 }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "#34D399" }}>{c.name}</div>
      <div style={{ color: "#888", fontSize: 11 }}>{c.email} · {c.phone || "no phone"}</div>
      {(c.opportunities || []).length > 0 ? (
        <div style={{ marginTop: 8 }}>
          {c.opportunities.map((o, i) => (
            <div key={i} style={{ padding: "6px 10px", background: "#0A0E14", borderRadius: 6, marginTop: 4, border: "1px solid #141920" }}>
              <span style={{ color: "#FBBF24", fontWeight: 700 }}>{o.pipeline}</span> · <span style={{ color: "#60A5FA" }}>{o.stage}</span> · <span style={{ color: "#888" }}>{o.status}</span>
            </div>
          ))}
        </div>
      ) : <div style={{ color: "#555", fontSize: 11, marginTop: 6 }}>No pipeline data</div>}
      <div style={{ color: "#555", fontSize: 10, marginTop: 8, fontFamily: "'JetBrains Mono',monospace" }}>
        tags: {(c.tags || []).join(", ") || "—"} · source: {c.source || "—"}
      </div>
    </div>
  );
}

function MetricsCard({ data }) {
  if (!data) return <div style={{ color: "#666", fontSize: 11 }}>No data yet.</div>;
  const cards = [
    { l: "Leads today", v: data.leads?.today || 0, c: "#34D399" },
    { l: "Total leads", v: data.leads?.total || 0, c: "#34D399" },
    { l: "Open opps",   v: data.opportunities?.open || 0, c: "#FBBF24" },
    { l: "Show rate",   v: `${data.bookings?.showRate || 0}%`, c: "#60A5FA" },
    { l: "Pipeline £",  v: `£${(data.opportunities?.totalValue || 0).toLocaleString()}`, c: "#FB923C" },
    { l: "Unread",      v: data.conversations?.unread || 0, c: "#F472B6" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
      {cards.map((c, i) => (
        <div key={i} style={{ background: "#0A0E14", border: `1px solid ${c.c}22`, borderRadius: 8, padding: 10, textAlign: "center" }}>
          <div style={{ color: c.c, fontWeight: 800, fontSize: 16 }}>{c.v}</div>
          <div style={{ color: "#555", fontSize: 9, marginTop: 2 }}>{c.l}</div>
        </div>
      ))}
    </div>
  );
}

function PipelineCard({ result }) {
  const pipelines = result?.pipelines || result || [];
  return (
    <div style={{ fontSize: 11, color: "#aaa" }}>
      {pipelines.map((p, i) => (
        <div key={i} style={{ marginBottom: 10, padding: 10, background: "#0A0E14", borderRadius: 8, border: "1px solid #141920" }}>
          <div style={{ fontWeight: 700, color: "#34D399", marginBottom: 4 }}>{p.name}</div>
          <div style={{ fontSize: 10, color: "#666" }}>{(p.stages || []).map(s => s.name).join(" → ")}</div>
        </div>
      ))}
    </div>
  );
}

function CopyResultCard({ result }) {
  const o = result?.output;
  if (!o) return <pre style={{ fontSize: 10, color: "#666" }}>{JSON.stringify(result, null, 2).substring(0, 400)}</pre>;
  return (
    <div style={{ fontSize: 11, color: "#aaa", lineHeight: 1.6 }}>
      <div style={{ fontSize: 10, color: "#888", marginBottom: 6 }}>Queued for review · <span style={{ color: "#A78BFA" }}>{result.id}</span></div>
      {o.headlines && <div><b style={{ color: "#A78BFA" }}>Headlines:</b> {o.headlines.slice(0, 3).join(" · ")}</div>}
      {o.ctas && <div style={{ marginTop: 6 }}><b style={{ color: "#A78BFA" }}>CTAs:</b> {o.ctas.slice(0, 3).join(" · ")}</div>}
    </div>
  );
}

function AgentResponse({ data }) {
  if (!data?.ok) return <div style={{ color: "#EF4444", fontSize: 11 }}>Error: {data?.error || "unknown"}</div>;
  const { agent, type, result } = data;

  let body;
  if (type === "lookup")    body = <LookupCard result={result} />;
  else if (type === "metrics") body = <MetricsCard data={result} />;
  else if (type === "pipelines") body = <PipelineCard result={result} />;
  else if (agent === "COPY") body = <CopyResultCard result={result} />;
  else if (agent === "ASSISTANT" && result?.reply) body = <div style={{ fontSize: 13, color: "#ddd", lineHeight: 1.6 }}>{result.reply}</div>;
  else body = <pre style={{ fontSize: 10, color: "#aaa", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 260, overflowY: "auto", fontFamily: "'JetBrains Mono',monospace" }}>{JSON.stringify(result, null, 2).substring(0, 2400)}</pre>;

  return (
    <div>
      <div style={{ fontSize: 9, color: "#888", fontFamily: "'JetBrains Mono',monospace", marginBottom: 6, letterSpacing: ".1em" }}>
        {agent} · {type}{data.routedVia ? ` · via ${data.routedVia}` : ""}
      </div>
      {body}
    </div>
  );
}

function CommandCentre() {
  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!cmd.trim() || loading) return;
    const text = cmd.trim();
    setCmd("");
    setLoading(true);
    const id = Date.now();
    setHistory(h => [{ id, role: "user", text, time: new Date() }, ...h]);
    try {
      const r = await fetch(`${DASH_API}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await r.json();
      setHistory(h => [{ id: id + 1, role: "agent", data, time: new Date() }, ...h]);
    } catch (e) {
      setHistory(h => [{ id: id + 1, role: "agent", data: { ok: false, error: e.message }, time: new Date() }, ...h]);
    }
    setLoading(false);
  };

  const suggestions = [
    "what's the show rate?",
    "look up Brett Ferguson",
    "generate ad copy for law firms",
    "show competitor ads for dentists",
    "should we pivot to dentists?",
    "generate creatives for SaaS",
    "what's pending review",
    "brief the team",
  ];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: 24 }}>
      <div style={{ fontSize: 10, color: "#666", letterSpacing: ".18em", marginBottom: 8, fontFamily: "'JetBrains Mono',monospace" }}>COMMAND CENTRE · NATURAL LANGUAGE ROUTER</div>
      <div style={{ flex: 1, overflowY: "auto", paddingRight: 8, marginBottom: 12 }}>
        {history.length === 0 && (
          <div style={{ color: "#444", fontSize: 12, fontFamily: "'JetBrains Mono',monospace", padding: 20 }}>
            Type a command below. Examples:
            <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {suggestions.map(s => (
                <button key={s} onClick={() => setCmd(s)} style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#00C2D4", background: "#00C2D408", border: "1px solid #00C2D433", borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {history.map(h => (
          <div key={h.id} style={{ marginBottom: 14, padding: 12, background: h.role === "user" ? "#00C2D408" : "#0A0E14", border: `1px solid ${h.role === "user" ? "#00C2D422" : "#141920"}`, borderRadius: 10 }}>
            <div style={{ fontSize: 8, color: "#555", fontFamily: "'JetBrains Mono',monospace", marginBottom: 6, letterSpacing: ".1em" }}>
              {h.role === "user" ? "YOU" : "AGENT"} · {h.time.toLocaleTimeString("en-GB")}
            </div>
            {h.role === "user"
              ? <div style={{ fontSize: 13, color: "#fff" }}>{h.text}</div>
              : <AgentResponse data={h.data} />}
          </div>
        ))}
      </div>
      <form onSubmit={submit} style={{ display: "flex", gap: 8, borderTop: "1px solid #141920", paddingTop: 12, alignItems: "center" }}>
        <button type="button" title="Voice input — coming soon" disabled style={{ background: "#0A0E14", border: "1px solid #1f2937", color: "#555", borderRadius: 10, padding: "10px 14px", fontSize: 14, cursor: "not-allowed" }}>🎤</button>
        <input
          type="text"
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          placeholder={loading ? "Thinking…" : "Ask anything · look up · generate · analyse…"}
          disabled={loading}
          style={{ flex: 1, background: "#0A0E14", border: "1px solid #1f2937", color: "#fff", borderRadius: 10, padding: "12px 16px", fontSize: 13, fontFamily: "'JetBrains Mono',monospace", outline: "none" }}
          autoFocus
        />
        <button type="button" title="Voice output — coming soon" disabled style={{ background: "#0A0E14", border: "1px solid #1f2937", color: "#555", borderRadius: 10, padding: "10px 14px", fontSize: 14, cursor: "not-allowed" }}>🔊</button>
        <button type="submit" disabled={loading || !cmd.trim()} style={{ background: "#00C2D4", border: "none", color: "#000", borderRadius: 10, padding: "10px 20px", fontWeight: 800, fontSize: 12, cursor: loading ? "wait" : "pointer", opacity: loading || !cmd.trim() ? 0.5 : 1 }}>
          {loading ? "…" : "SEND"}
        </button>
      </form>
    </div>
  );
}

function CopyContent({ c, color }) {
  return (
    <div style={{ fontSize: 11, color: "#aaa", lineHeight: 1.6 }}>
      {c.headlines && <div style={{ marginBottom: 8 }}><b style={{ color }}>Headlines:</b> {c.headlines.join(" · ")}</div>}
      {c.ctas && <div style={{ marginBottom: 8 }}><b style={{ color }}>CTAs:</b> {c.ctas.join(" · ")}</div>}
      {c.angle_rewrites && <div><b style={{ color }}>Angles:</b> {c.angle_rewrites.map(a => a.angle).join(", ")}</div>}
    </div>
  );
}

function BriefContent({ c, color }) {
  return (
    <div style={{ fontSize: 11, color: "#aaa", lineHeight: 1.6 }}>
      {c.brief && <div style={{ marginBottom: 8, color: "#ddd" }}>{c.brief}</div>}
      <div><b style={{ color }}>{(c.reels?.length || 0)} reels · {(c.youtube_shorts?.length || 0)} shorts · {(c.face_to_camera?.length || 0)} F2C · {(c.hook_variations?.length || 0)} hooks</b></div>
    </div>
  );
}

function CreativeContent({ c, color }) {
  const urls = c.imageUrls || [];
  return (
    <div style={{ fontSize: 11, color: "#aaa", lineHeight: 1.6 }}>
      {c.copyText && <div style={{ marginBottom: 8 }}><b style={{ color }}>Copy:</b> {c.copyText}</div>}
      {c.prompt && <div style={{ marginBottom: 8, color: "#666", fontStyle: "italic" }}>Prompt: {c.prompt.substring(0, 200)}</div>}
      {urls.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 10 }}>
          {urls.slice(0, 4).map((u, i) => (
            <a key={i} href={u} target="_blank" rel="noreferrer" style={{ display: "block" }}>
              <img src={u} alt={`variant ${i + 1}`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: `1px solid ${color}33` }} />
            </a>
          ))}
        </div>
      ) : <div style={{ color: "#666", fontSize: 11 }}>{c.variantCount ? `${c.variantCount} variants generated` : "No images yet"}</div>}
    </div>
  );
}

function ReviewCard({ item, onDecided }) {
  const color = AGENT_DEFS.find(a => a.name === item.agent)?.color || "#888";
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);

  const handle = async (action) => {
    setBusy(true);
    await decideReview(item.id, action, feedback);
    setBusy(false);
    onDecided();
  };

  const content = item.content || {};

  return (
    <div style={{ background: "#0A0E14", border: `1px solid ${color}33`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 10, color, fontFamily: "'JetBrains Mono',monospace", letterSpacing: ".15em" }}>{item.agent} · {item.type}</div>
          <div style={{ fontSize: 10, color: "#555", marginTop: 2, fontFamily: "'JetBrains Mono',monospace" }}>{item.id}</div>
          <div style={{ fontSize: 10, color: "#666", marginTop: 2 }}>{new Date(item.createdAt).toLocaleString("en-GB")}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button disabled={busy} onClick={() => handle("approve")} style={{ background: "#34D39915", border: "1px solid #34D39944", color: "#34D399", borderRadius: 6, padding: "6px 12px", fontSize: 10, cursor: busy ? "wait" : "pointer", fontFamily: "'JetBrains Mono',monospace", opacity: busy ? 0.5 : 1 }}>✓ APPROVE</button>
          <button disabled={busy} onClick={() => handle("reject")} style={{ background: "#EF444415", border: "1px solid #EF444444", color: "#EF4444", borderRadius: 6, padding: "6px 12px", fontSize: 10, cursor: busy ? "wait" : "pointer", fontFamily: "'JetBrains Mono',monospace", opacity: busy ? 0.5 : 1 }}>✕ REJECT</button>
        </div>
      </div>

      {item.type === "copy" && <CopyContent c={content} color={color} />}
      {item.type === "brief" && <BriefContent c={content} color={color} />}
      {item.type === "creative" && <CreativeContent c={content} color={color} />}
      {!["copy", "brief", "creative"].includes(item.type) && (
        <pre style={{ fontSize: 10, color: "#888", fontFamily: "'JetBrains Mono',monospace", whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto" }}>{JSON.stringify(content, null, 2).substring(0, 800)}</pre>
      )}

      <input
        type="text"
        value={feedback}
        onChange={e => setFeedback(e.target.value)}
        placeholder="Optional feedback for the agent…"
        style={{ marginTop: 10, width: "100%", background: "#060A0F", border: "1px solid #1f2937", color: "#bbb", borderRadius: 6, padding: "6px 10px", fontSize: 11, fontFamily: "'JetBrains Mono',monospace", outline: "none" }}
      />
    </div>
  );
}

function ReviewView({ queue }) {
  const byType = { copy: [], brief: [], creative: [], other: [] };
  for (const i of queue.pending) {
    const bucket = byType[i.type] ? i.type : "other";
    byType[bucket].push(i);
  }
  const groups = [
    { key: "creative", label: "CREATIVES", color: "#FB923C" },
    { key: "copy",     label: "COPY",      color: "#A78BFA" },
    { key: "brief",    label: "BRIEFS",    color: "#FB923C" },
    { key: "other",    label: "OTHER",     color: "#888" },
  ];

  return (
    <div style={{ padding: 24, overflowY: "auto", height: "100%" }}>
      <div style={{ fontSize: 10, color: "#666", letterSpacing: ".18em", marginBottom: 16, fontFamily: "'JetBrains Mono',monospace" }}>
        CREATIVE REVIEW · {queue.pending.length} PENDING
      </div>
      {queue.pending.length === 0 && <div style={{ color: "#444", fontSize: 12, padding: 40, textAlign: "center" }}>Nothing waiting. COPY 10am · CRTV 10:30am · ADGEN triggered on COPY approval.</div>}
      {groups.map(g => byType[g.key].length > 0 && (
        <div key={g.key}>
          <div style={{ fontSize: 11, color: g.color, letterSpacing: ".15em", marginTop: 20, marginBottom: 10, fontFamily: "'JetBrains Mono',monospace" }}>{g.label} · {byType[g.key].length}</div>
          {byType[g.key].map(i => <ReviewCard key={i.id} item={i} onDecided={queue.refresh} />)}
        </div>
      ))}
    </div>
  );
}

export default function AgentRoom() {
  const dashData = useDashData();
  const discordStats = useDiscordStats();
  const adStats = useAdStats();
  const activityFeed = useActivityFeed();
  const reviewQueue = useReviewQueue();
  const [agents, setAgents] = useState(AGENT_DEFS.map(a => { const c = getRoomCenter(a.homeRoom); return { ...a, x: c.x + (Math.random() - .5) * 50, y: c.y + (Math.random() - .5) * 35, currentRoom: a.homeRoom, carrying: false }; }));
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [log, setLog] = useState([]);
  const [time, setTime] = useState(new Date());
  const [view, setView] = useState("floor");
  const pendingReviewCount = reviewQueue.pending.length;

  // Per-agent activity summary (last action + count)
  const agentActivity = {};
  for (const e of activityFeed) {
    if (!agentActivity[e.agent]) agentActivity[e.agent] = { last: e, count: 0 };
    agentActivity[e.agent].count += 1;
  }
  // Per-agent pending-review count
  const agentPending = {};
  for (const i of reviewQueue.pending) agentPending[i.agent] = (agentPending[i.agent] || 0) + 1;

  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (dashData && log.length === 0) setLog([
    { text: `DASH: ${dashData.leads?.today || 0} leads today`, color: "#34D399" },
    { text: `FLUP: chase + recovery active`, color: "#60A5FA" },
    { text: `CMMS: inbox scanning`, color: "#F472B6" },
    { text: `OPS: systems nominal`, color: "#2DD4BF" },
    { text: `CSM: Discord monitoring`, color: "#5865F2" },
    { text: `AUTO: health checks running`, color: "#00C2D4" },
  ]); }, [dashData]);

  useEffect(() => { const iv = setInterval(() => { setAgents(prev => {
    const idx = Math.floor(Math.random() * prev.length); const agent = prev[idx];
    if (agent.name === "CSM") return prev;
    const live = AGENT_DEFS.filter(a => a.status === "live").map(a => a.name);
    if (!live.includes(agent.name) && Math.random() > .15) return prev;
    const ids = ROOMS.map(r => r.id).filter(r => r !== "csm");
    const nr = ids[Math.floor(Math.random() * ids.length)]; if (nr === agent.currentRoom) return prev;
    const c = getRoomCenter(nr); const carry = Math.random() > .45; const u = [...prev];
    u[idx] = { ...agent, x: c.x + (Math.random() - .5) * 50, y: c.y + (Math.random() - .5) * 35, currentRoom: nr, carrying: carry };
    const rn = ROOMS.find(r => r.id === nr)?.name;
    setLog(l => [{ text: `${agent.name} → ${rn}${carry ? " 📦" : ""}`, color: agent.color }, ...l].slice(0, 12));
    return u;
  }); }, 1500); return () => clearInterval(iv); }, []);

  const liveCount = AGENT_DEFS.filter(a => a.status === "live").length;
  const getSnippet = (id) => {
    if (dashData && id === "leads") return `${dashData.leads?.today || 0} leads · ${dashData.bookings?.showRate || 0}% show`;
    if (dashData && id === "comms") return `${dashData.conversations?.unread || 0} unread · CMMS active`;
    if (dashData && id === "followup") return `FLUP: SMS + workflows`;
    if (id === "pipeline") return "AUTO: hourly checks";
    if (id === "ops") return "OPS: 5-min watch";
    if (id === "csm") return "CSM: AI replies";
    return "Coming soon";
  };

  return (<>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');
      *{box-sizing:border-box;margin:0;padding:0}body{background:#060A0F;overflow:hidden}
      @keyframes bob{from{transform:translateY(0)}to{transform:translateY(-2px)}}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
      @keyframes panelIn{from{opacity:0;transform:scale(.94) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}
      @keyframes logSlide{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
      @keyframes scanline{0%{top:-2px}100%{top:100vh}}
      .rc{transition:all .2s;cursor:pointer}.rc:hover{filter:brightness(1.18);transform:scale(1.015)}
      ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#1a1a1a;border-radius:2px}
      .vt{padding:6px 14px;font-size:10px;cursor:pointer;border:1px solid #111;border-radius:6px;color:#444;background:transparent;font-family:'JetBrains Mono',monospace;transition:all .2s}
      .vt:hover{color:#888;border-color:#222}.vt.a{color:#00C2D4;border-color:#00C2D4;background:#00C2D408}
    `}</style>
    <div style={{ height: "100vh", background: "#060A0F", fontFamily: "'Syne',sans-serif", color: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ position: "fixed", left: 0, right: 0, height: 2, background: "linear-gradient(transparent,#00C2D40A,transparent)", animation: "scanline 9s linear infinite", pointerEvents: "none", zIndex: 99 }} />
      <div style={{ padding: "12px 24px", borderBottom: "1px solid #0f0f0f", background: "#080C12", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <div><div style={{ fontSize: 9, color: "#00C2D4", letterSpacing: ".22em", fontFamily: "'JetBrains Mono',monospace", marginBottom: 2 }}>ECHO GROWTH · AGENT HQ</div><div style={{ fontWeight: 800, fontSize: 17 }}>Operations Floorplan</div></div>
        <div style={{ display: "flex", gap: 8 }}>
          {[
            { id: "floor", label: "Floor" },
            { id: "agents", label: "Agents" },
            { id: "pipeline", label: "Pipeline" },
            { id: "command", label: "Command" },
            { id: "review", label: `Review${pendingReviewCount > 0 ? ` (${pendingReviewCount})` : ""}` },
          ].map(v => <button key={v.id} className={`vt ${view === v.id ? "a" : ""}`} onClick={() => setView(v.id)}>{v.label}</button>)}
        </div>
        <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
          {[{ l: "Live", v: liveCount, c: "#34D399" }, { l: "Planned", v: AGENT_DEFS.length - liveCount, c: "#555" }, { l: "GHL Leads", v: dashData ? dashData.leads?.total || 0 : "—", c: "#FBBF24" }].map((s, i) => (
            <div key={i} style={{ textAlign: "center" }}><div style={{ color: s.c, fontWeight: 800, fontSize: 17 }}>{s.v}</div><div style={{ color: "#333", fontSize: 9 }}>{s.l}</div></div>
          ))}
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: dashData ? "#34D399" : "#EF4444", boxShadow: dashData ? "0 0 6px #34D399" : "none" }} />
          <div style={{ fontFamily: "'JetBrains Mono',monospace", color: "#00C2D4", fontSize: 14 }}>{time.toLocaleTimeString("en-GB")}</div>
        </div>
      </div>
      <MetricsBar dashData={dashData} discordStats={discordStats} adStats={adStats} />
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {view === "floor" && (<>
            <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(#00C2D405 1px,transparent 1px),linear-gradient(90deg,#00C2D405 1px,transparent 1px)", backgroundSize: "30px 30px" }} />
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }}>
              {CORRIDORS.map((c, i) => { const f = getRoomCenter(c.from), t = getRoomCenter(c.to); return <line key={i} x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke="#ffffff07" strokeWidth={10} strokeDasharray="5 8" />; })}
            </svg>
            {ROOMS.map(room => { const ra = agents.filter(a => a.currentRoom === room.id); const hasLive = ra.some(a => AGENT_DEFS.find(d => d.name === a.name)?.status === "live"); return (
              <div key={room.id} className="rc" onClick={() => setSelectedRoom(room)} style={{ position: "absolute", left: room.x, top: room.y, width: room.w, height: room.h, background: room.color + "0D", border: `2px solid ${hasLive ? room.color + "50" : room.color + "20"}`, borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between", zIndex: 10 }}>
                <div><div style={{ fontSize: 16, marginBottom: 3 }}>{room.icon}</div><div style={{ fontWeight: 800, fontSize: 12 }}>{room.name}</div><div style={{ fontSize: 8, color: "#444", marginTop: 2, fontFamily: "'JetBrains Mono',monospace" }}>{getSnippet(room.id)}</div></div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ display: "flex", gap: 3 }}>{ra.map(a => <div key={a.id} style={{ width: 7, height: 7, borderRadius: "50%", background: a.color, boxShadow: `0 0 4px ${a.color}`, opacity: AGENT_DEFS.find(d => d.name === a.name)?.status === "live" ? 1 : .3 }} />)}</div><div style={{ fontSize: 9, color: room.color, background: room.color + "18", border: `1px solid ${room.color}33`, borderRadius: 5, padding: "2px 7px" }}>{ra.length}</div></div>
              </div>); })}
            {agents.map(a => <AgentSprite key={a.id} agent={a} />)}
            <div style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", fontSize: 9, color: "#222", letterSpacing: ".15em" }}>CLICK ANY ROOM TO INSPECT</div>
          </>)}
          {view === "agents" && (<div style={{ padding: 24, overflowY: "auto", height: "100%" }}><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
            {AGENT_DEFS.map(a => {
              const blurb = {
                DASH: "GHL data every 15 mins. Pipeline stages. 7am/11pm briefings.",
                CSM: "Discord AI bot. Triage, client lookup, channel counters, call review.",
                FLUP: "9am chase + 2pm recovery. SMS, workflows, dead-lead cleanup.",
                AUTO: "Hourly GHL checks. Fixes tag conflicts. Flags stuck contacts.",
                OPS: "5-min system watch. Auto-restart. Daily report 8am.",
                CMMS: "15-min inbox scans. Milestones. Asset chase. Draft replies.",
                COPY: "Daily 10am copy batch. Approve → fires ADGEN.",
                CRTV: "10:30am creative briefs for Kieran/Mason/Eric.",
                STRT: "Sunday 7pm strategy. On-demand via Command Centre.",
                FUNL: "11am funnel scan. <15% triggers a COPY rewrite.",
                ADLIB: "8am Windsor.ai pull. Fatigue alerts. READ ONLY.",
                ADGEN: "Higgsfield image gen. Triggered by COPY approval.",
                ADSPY: "7:30am competitor synth per niche. Feeds COPY/CRTV.",
                META: "Coming soon — needs Meta Ads API.",
              }[a.name];
              const last = agentActivity[a.name]?.last;
              const lastTime = last ? new Date(last.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
              const pending = agentPending[a.name] || 0;
              return (
                <div key={a.id} style={{ background: "#0A0E14", border: `1px solid ${a.status === "live" ? a.color + "33" : "#111"}`, borderRadius: 16, padding: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <div style={{ width: 12, height: 12, borderRadius: "50%", background: a.color, boxShadow: a.status === "live" ? `0 0 8px ${a.color}` : "none", opacity: a.status === "live" ? 1 : .3 }} />
                    <div><div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, color: a.color, fontSize: 16 }}>{a.name}</div><div style={{ color: "#555", fontSize: 11 }}>{a.role}</div></div>
                    <div style={{ marginLeft: "auto", fontSize: 9, padding: "3px 8px", borderRadius: 6, background: a.status === "live" ? "#34D39915" : "#fff08", color: a.status === "live" ? "#34D399" : "#444", fontFamily: "'JetBrains Mono',monospace" }}>{a.status === "live" ? "● LIVE" : "○ PLANNED"}</div>
                  </div>
                  <div style={{ fontSize: 11, color: "#666", lineHeight: 1.5, fontFamily: "'JetBrains Mono',monospace", marginBottom: 10 }}>{blurb}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #141920", paddingTop: 10 }}>
                    <div style={{ fontSize: 9, color: lastTime ? "#888" : "#333", fontFamily: "'JetBrains Mono',monospace" }}>
                      {lastTime ? `${lastTime} · ${last.action}` : "no recent activity"}
                    </div>
                    {pending > 0 && <div style={{ fontSize: 9, color: "#FBBF24", background: "#FBBF2415", border: "1px solid #FBBF2444", borderRadius: 5, padding: "2px 8px", fontFamily: "'JetBrains Mono',monospace" }}>{pending} pending</div>}
                  </div>
                </div>
              );
            })}
          </div></div>)}
          {view === "pipeline" && dashData && (<div style={{ padding: 24, overflowY: "auto", height: "100%" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16, marginBottom: 24 }}>
              {[{ l: "Total Leads", v: dashData.leads?.total || 0, c: "#34D399" }, { l: "New Today", v: dashData.leads?.today || 0, c: "#34D399" }, { l: "Open Opps", v: dashData.opportunities?.open || 0, c: "#FBBF24" }, { l: "Show Rate", v: `${dashData.bookings?.showRate || 0}%`, c: "#60A5FA" }].map((s, i) => (
                <div key={i} style={{ background: "#0A0E14", border: "1px solid #141920", borderRadius: 14, padding: 16, textAlign: "center" }}>
                  <div style={{ color: s.c, fontWeight: 800, fontSize: 28, fontFamily: "'Syne',sans-serif" }}>{s.v}</div><div style={{ color: "#444", fontSize: 9, marginTop: 4 }}>{s.l}</div>
                </div>))}
            </div>
            {dashData.opportunities?.pipelines?.map((p, i) => { const active = Object.entries(p.stages || {}).filter(([_, c]) => c > 0); return (
              <div key={i} style={{ background: "#0A0E14", border: "1px solid #141920", borderRadius: 14, padding: 20, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>{p.name}</div><div style={{ fontSize: 12, color: "#34D399", fontFamily: "'JetBrains Mono',monospace" }}>{p.total}</div>
                </div>
                {active.length > 0 ? active.map(([n, c], j) => (<div key={j} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                  <div style={{ flex: 1, fontSize: 11, color: "#888" }}>{n}</div>
                  <div style={{ fontSize: 12, color: "#fff", fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, minWidth: 30, textAlign: "right" }}>{c}</div>
                  <div style={{ width: 120, height: 6, background: "#111", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min((c / Math.max(p.total, 1)) * 100, 100)}%`, background: "linear-gradient(90deg,#34D399,#00C2D4)", borderRadius: 3 }} />
                  </div>
                </div>)) : <div style={{ color: "#333", fontSize: 11 }}>Empty</div>}
              </div>); })}
          </div>)}
          {view === "pipeline" && !dashData && <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#333" }}>Connecting to DASH...</div>}
          {view === "command" && <CommandCentre />}
          {view === "review" && <ReviewView queue={reviewQueue} />}
        </div>
        <div style={{ width: 240, background: "#080C12", borderLeft: "1px solid #0f0f0f", padding: 16, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ fontSize: 9, color: "#333", letterSpacing: ".15em", marginBottom: 12, fontFamily: "'JetBrains Mono',monospace" }}>AGENT ACTIVITY · LIVE</div>
          <div style={{ flex: 1, overflowY: "auto", marginBottom: 14 }}>
            {activityFeed.length === 0 && <div style={{ fontSize: 10, color: "#333", padding: 8 }}>No activity yet</div>}
            {activityFeed.map((e, i) => (
              <div key={`${e.timestamp}-${i}`} style={{ marginBottom: 10, borderLeft: `2px solid ${e.color}66`, paddingLeft: 8, animation: i === 0 ? "logSlide .3s ease" : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 4 }}>
                  <span style={{ fontSize: 9, color: e.color, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, letterSpacing: ".05em" }}>{e.agent}</span>
                  <span style={{ fontSize: 8, color: "#333", fontFamily: "'JetBrains Mono',monospace" }}>{new Date(e.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div style={{ fontSize: 10, color: "#bbb", fontFamily: "'JetBrains Mono',monospace", marginTop: 2 }}>{e.action}</div>
                {e.details && <div style={{ fontSize: 9, color: "#555", fontFamily: "'JetBrains Mono',monospace", marginTop: 1 }}>{e.details}</div>}
              </div>
            ))}
          </div>
          <div style={{ borderTop: "1px solid #0f0f0f", paddingTop: 12 }}>
            <div style={{ fontSize: 9, color: "#333", letterSpacing: ".15em", marginBottom: 10, fontFamily: "'JetBrains Mono',monospace" }}>AGENTS</div>
            {agents.map(a => { const def = AGENT_DEFS.find(d => d.name === a.name); const live = def?.status === "live"; return (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6, padding: "4px 6px", background: live ? a.color + "06" : "transparent", borderRadius: 6 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: live ? a.color : "#333", boxShadow: live ? `0 0 4px ${a.color}` : "none", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 9, color: live ? a.color : "#333", fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>{a.name}</div>
                </div>
                <div style={{ fontSize: 7, color: live ? "#34D399" : "#222", fontFamily: "'JetBrains Mono',monospace" }}>{live ? "ON" : "—"}</div>
              </div>); })}
          </div>
        </div>
      </div>
      {selectedRoom && <RoomPanel room={selectedRoom} agents={agents} dashData={dashData} onClose={() => setSelectedRoom(null)} />}
    </div>
  </>);
}
