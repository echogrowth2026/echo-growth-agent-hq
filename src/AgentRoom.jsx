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

function useActivityFeed() {
  const [a, setA] = useState([]);
  const f = useCallback(async () => { try { const r = await fetch(`${DASH_API}/api/agents/activity?limit=80`); if (r.ok) { const d = await r.json(); setA(d.activity || []); } } catch {} }, []);
  useEffect(() => { f(); const iv = setInterval(f, 30000); return () => clearInterval(iv); }, [f]);
  return a;
}

function usePendingReviews() {
  const [copy, setCopy] = useState([]);
  const [crtv, setCrtv] = useState([]);
  const f = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([
        fetch(`${DASH_API}/api/copy/pending`).then(r => r.ok ? r.json() : { pending: [] }),
        fetch(`${DASH_API}/api/crtv/pending`).then(r => r.ok ? r.json() : { pending: [] }),
      ]);
      setCopy(c.pending || []);
      setCrtv(r.pending || []);
    } catch {}
  }, []);
  useEffect(() => { f(); const iv = setInterval(f, 30000); return () => clearInterval(iv); }, [f]);
  return { copy, crtv, refresh: f };
}

async function decide(kind, id, action, feedback = "") {
  try {
    await fetch(`${DASH_API}/api/${kind}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, feedback }),
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

function MetricsBar({ dashData, discordStats }) {
  const items = [
    { l: "New Leads Today", v: discordStats?.today?.leads ?? 0, c: "#34D399" },
    { l: "Booked Calls Today", v: discordStats?.today?.calls ?? 0, c: "#60A5FA" },
    { l: "Payments (Month)", v: discordStats?.month?.payments ?? 0, c: "#FBBF24" },
    { l: "Revenue MTD", v: `£${(discordStats?.month?.paymentsAmount || 0).toLocaleString()}`, c: "#E879F9" },
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
        body: JSON.stringify({ text }),
      });
      const data = await r.json();
      setHistory(h => [{ id: id + 1, role: "agent", data, time: new Date() }, ...h]);
    } catch (e) {
      setHistory(h => [{ id: id + 1, role: "agent", data: { ok: false, error: e.message }, time: new Date() }, ...h]);
    }
    setLoading(false);
  };

  const renderAgentResponse = (d) => {
    if (!d?.ok) return <div style={{ color: "#EF4444", fontSize: 11 }}>Error: {d?.error || "unknown"}</div>;
    const { agent, type, result } = d;
    return (
      <div>
        <div style={{ fontSize: 9, color: "#888", fontFamily: "'JetBrains Mono',monospace", marginBottom: 6, letterSpacing: ".1em" }}>{agent} · {type}</div>
        <pre style={{ fontSize: 10, color: "#aaa", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 260, overflowY: "auto", fontFamily: "'JetBrains Mono',monospace" }}>
          {JSON.stringify(result, null, 2).substring(0, 2400)}
        </pre>
      </div>
    );
  };

  const suggestions = [
    "what's the show rate?",
    "look up Brett Ferguson",
    "generate ad copy for law firms",
    "should we pivot to dentists?",
    "brief the team",
    "ad library trends",
  ];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: 24 }}>
      <div style={{ fontSize: 10, color: "#666", letterSpacing: ".18em", marginBottom: 8, fontFamily: "'JetBrains Mono',monospace" }}>COMMAND CENTRE · TEXT ROUTER</div>
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
              : renderAgentResponse(h.data)}
          </div>
        ))}
      </div>
      <form onSubmit={submit} style={{ display: "flex", gap: 8, borderTop: "1px solid #141920", paddingTop: 12 }}>
        <input
          type="text"
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          placeholder={loading ? "Thinking…" : "Ask anything · look up · generate · analyse…"}
          disabled={loading}
          style={{ flex: 1, background: "#0A0E14", border: "1px solid #1f2937", color: "#fff", borderRadius: 10, padding: "12px 16px", fontSize: 13, fontFamily: "'JetBrains Mono',monospace", outline: "none" }}
          autoFocus
        />
        <button type="submit" disabled={loading || !cmd.trim()} style={{ background: "#00C2D4", border: "none", color: "#000", borderRadius: 10, padding: "10px 20px", fontWeight: 800, fontSize: 12, cursor: loading ? "wait" : "pointer", opacity: loading || !cmd.trim() ? 0.5 : 1 }}>
          {loading ? "…" : "SEND"}
        </button>
      </form>
    </div>
  );
}

function ReviewCard({ kind, entry, onDecided }) {
  const isCopy = kind === "copy";
  const o = entry.output || {};
  const color = isCopy ? "#A78BFA" : "#FB923C";

  const handle = async (action) => {
    await decide(kind, entry.id, action);
    onDecided();
  };

  return (
    <div style={{ background: "#0A0E14", border: `1px solid ${color}33`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 10, color, fontFamily: "'JetBrains Mono',monospace", letterSpacing: ".15em" }}>{isCopy ? "COPY" : "CRTV"} · {entry.id}</div>
          <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{new Date(entry.timestamp).toLocaleString("en-GB")}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => handle("approve")} style={{ background: "#34D39915", border: "1px solid #34D39944", color: "#34D399", borderRadius: 6, padding: "6px 12px", fontSize: 10, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace" }}>✓ APPROVE</button>
          <button onClick={() => handle("reject")} style={{ background: "#EF444415", border: "1px solid #EF444444", color: "#EF4444", borderRadius: 6, padding: "6px 12px", fontSize: 10, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace" }}>✕ REJECT</button>
        </div>
      </div>
      {isCopy && (
        <div style={{ fontSize: 11, color: "#aaa", lineHeight: 1.6 }}>
          {o.headlines && <div style={{ marginBottom: 8 }}><b style={{ color }}>Headlines:</b> {o.headlines.join(" · ")}</div>}
          {o.ctas && <div style={{ marginBottom: 8 }}><b style={{ color }}>CTAs:</b> {o.ctas.join(" · ")}</div>}
          {o.angle_rewrites && <div><b style={{ color }}>Angles:</b> {o.angle_rewrites.map(a => a.angle).join(", ")}</div>}
        </div>
      )}
      {!isCopy && (
        <div style={{ fontSize: 11, color: "#aaa", lineHeight: 1.6 }}>
          {o.brief && <div style={{ marginBottom: 8, color: "#ddd" }}>{o.brief}</div>}
          <div><b style={{ color }}>{(o.reels?.length || 0)} reels · {(o.youtube_shorts?.length || 0)} shorts · {(o.face_to_camera?.length || 0)} F2C · {(o.hook_variations?.length || 0)} hooks</b></div>
        </div>
      )}
    </div>
  );
}

function ReviewView({ reviews }) {
  const total = reviews.copy.length + reviews.crtv.length;
  return (
    <div style={{ padding: 24, overflowY: "auto", height: "100%" }}>
      <div style={{ fontSize: 10, color: "#666", letterSpacing: ".18em", marginBottom: 16, fontFamily: "'JetBrains Mono',monospace" }}>
        CREATIVE REVIEW · {total} PENDING
      </div>
      {total === 0 && <div style={{ color: "#444", fontSize: 12, padding: 40, textAlign: "center" }}>Nothing waiting for review. COPY runs 10am, CRTV 10:30am Mon-Fri.</div>}
      {reviews.copy.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "#A78BFA", letterSpacing: ".15em", marginBottom: 10, fontFamily: "'JetBrains Mono',monospace" }}>COPY · {reviews.copy.length}</div>
          {reviews.copy.map(e => <ReviewCard key={e.id} kind="copy" entry={e} onDecided={reviews.refresh} />)}
        </>
      )}
      {reviews.crtv.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: "#FB923C", letterSpacing: ".15em", marginTop: 20, marginBottom: 10, fontFamily: "'JetBrains Mono',monospace" }}>CRTV · {reviews.crtv.length}</div>
          {reviews.crtv.map(e => <ReviewCard key={e.id} kind="crtv" entry={e} onDecided={reviews.refresh} />)}
        </>
      )}
    </div>
  );
}

export default function AgentRoom() {
  const dashData = useDashData();
  const discordStats = useDiscordStats();
  const activityFeed = useActivityFeed();
  const reviews = usePendingReviews();
  const [agents, setAgents] = useState(AGENT_DEFS.map(a => { const c = getRoomCenter(a.homeRoom); return { ...a, x: c.x + (Math.random() - .5) * 50, y: c.y + (Math.random() - .5) * 35, currentRoom: a.homeRoom, carrying: false }; }));
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [log, setLog] = useState([]);
  const [time, setTime] = useState(new Date());
  const [view, setView] = useState("floor");
  const pendingReviewCount = reviews.copy.length + reviews.crtv.length;

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
      <MetricsBar dashData={dashData} discordStats={discordStats} />
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
            {AGENT_DEFS.map(a => (<div key={a.id} style={{ background: "#0A0E14", border: `1px solid ${a.status === "live" ? a.color + "33" : "#111"}`, borderRadius: 16, padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div style={{ width: 12, height: 12, borderRadius: "50%", background: a.color, boxShadow: a.status === "live" ? `0 0 8px ${a.color}` : "none", opacity: a.status === "live" ? 1 : .3 }} />
                <div><div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, color: a.color, fontSize: 16 }}>{a.name}</div><div style={{ color: "#555", fontSize: 11 }}>{a.role}</div></div>
                <div style={{ marginLeft: "auto", fontSize: 9, padding: "3px 8px", borderRadius: 6, background: a.status === "live" ? "#34D39915" : "#fff08", color: a.status === "live" ? "#34D399" : "#444", fontFamily: "'JetBrains Mono',monospace" }}>{a.status === "live" ? "● LIVE" : "○ PLANNED"}</div>
              </div>
              <div style={{ fontSize: 11, color: "#666", lineHeight: 1.5, fontFamily: "'JetBrains Mono',monospace" }}>
                {{ DASH: "GHL data every 15 mins. Pipeline stages. 7am/11pm briefings.", CSM: "Discord AI bot. Triage. Client lookup. Data-backed replies.", FLUP: "9am chase + 2pm recovery. SMS, workflows, dead leads.", AUTO: "Hourly GHL checks. Fixes tags. Flags stuck contacts.", OPS: "5-min system watch. Auto-restart. Daily report.", CMMS: "15-min inbox scans. AI draft replies. Escalations.", META: "Coming soon — needs Meta Ads API.", COPY: "Coming soon — AI copywriter for ad rewrites.", CRTV: "Coming soon — script generator for content team.", FUNL: "Coming soon — funnel conversion tracker.", STRT: "Coming soon — weekly strategy analysis." }[a.name]}
              </div>
            </div>))}
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
          {view === "review" && <ReviewView reviews={reviews} />}
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
