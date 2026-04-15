import { useState, useEffect, useCallback } from "react";

// ─── ROOM DEFINITIONS ───────────────────────────────────────────────
export const ROOMS = [
  { id: "ads",      name: "Ad Copy",       x: 40,  y: 50,  w: 190, h: 120, color: "#FF6B35", icon: "✍️",  discord: false },
  { id: "creatives",name: "Ad Creatives",  x: 280, y: 50,  w: 190, h: 120, color: "#A78BFA", icon: "🎨",  discord: false },
  { id: "pipeline", name: "Pipeline Setup",x: 520, y: 50,  w: 190, h: 120, color: "#00C2D4", icon: "⚙️",  discord: false },
  { id: "leads",    name: "Lead Room",     x: 40,  y: 230, w: 190, h: 120, color: "#34D399", icon: "📊",  discord: false },
  { id: "funnels",  name: "Funnel Lab",    x: 280, y: 230, w: 190, h: 120, color: "#FBBF24", icon: "🔧",  discord: false },
  { id: "comms",    name: "Client Comms",  x: 520, y: 230, w: 190, h: 120, color: "#F472B6", icon: "💬",  discord: false },
  { id: "strategy", name: "Strategy Room", x: 40,  y: 410, w: 190, h: 120, color: "#E879F9", icon: "🧠",  discord: false },
  { id: "ops",      name: "Ops Deck",      x: 280, y: 410, w: 190, h: 120, color: "#2DD4BF", icon: "🛠️",  discord: false },
  { id: "csm",      name: "CSM Suite",     x: 520, y: 410, w: 190, h: 120, color: "#5865F2", icon: "🎮",  discord: true  },
];

// ─── AGENT DEFINITIONS ──────────────────────────────────────────────
export const AGENT_DEFS = [
  {
    id: 1, name: "META", color: "#FF6B35", homeRoom: "ads",
    role: "Meta Ads Monitor",
    tasks: ["Pull spend vs results", "Flag underperforming ad sets", "Identify budget bleed", "Surface winning creatives"],
    inputs: ["Meta Ads API", "Client ad account IDs"],
    outputs: ["Daily performance summary", "Pause/scale recommendations"],
    connects: ["COPY", "DASH"],
    trigger: "Daily 7am + on demand",
  },
  {
    id: 2, name: "COPY", color: "#A78BFA", homeRoom: "ads",
    role: "Ad Copywriter",
    tasks: ["Rewrite underperforming ads", "Generate headline variants", "A/B test angles", "Rewrite CTAs"],
    inputs: ["Current ad copy", "META agent performance data", "Offer/niche context"],
    outputs: ["3–5 rewrite variants per ad", "Ranked by conversion likelihood"],
    connects: ["META", "CRTV"],
    trigger: "Triggered by META agent or manually",
  },
  {
    id: 3, name: "AUTO", color: "#00C2D4", homeRoom: "pipeline",
    role: "GHL Automation Agent",
    tasks: ["Check for broken workflows", "Update contact tags", "Build new automations", "Configure niche snapshots"],
    inputs: ["GHL API", "Client sub-account data", "Snapshot templates"],
    outputs: ["Live automations", "Updated pipelines", "Error reports"],
    connects: ["FLUP", "CMMS", "DASH"],
    trigger: "On schedule + new client added",
  },
  {
    id: 4, name: "FUNL", color: "#FBBF24", homeRoom: "funnels",
    role: "Funnel Auditor",
    tasks: ["Review funnel step conversions", "Flag drop-off points", "Rewrite page copy", "Fix broken elements"],
    inputs: ["GHL funnel data", "Conversion stats", "COPY agent output"],
    outputs: ["Funnel audit report", "Copy rewrites", "Fixed pages"],
    connects: ["AUTO", "COPY", "DASH"],
    trigger: "Weekly audit + conversion drop threshold",
  },
  {
    id: 5, name: "DASH", color: "#34D399", homeRoom: "leads",
    role: "Dashboard Intelligence",
    tasks: ["Aggregate lead numbers", "Check booking rate", "Calculate show rate", "Compile founder briefing"],
    inputs: ["GHL API", "META agent data", "FUNL conversion data"],
    outputs: ["Daily founder briefing 7am", "Show rate report", "Priority action list", "End of day summary 11pm"],
    connects: ["ALL"],
    trigger: "7am daily briefing · 11pm summary",
  },
  {
    id: 6, name: "FLUP", color: "#60A5FA", homeRoom: "leads",
    role: "Follow-Up Agent",
    tasks: ["Chase enquiries that haven't booked", "Re-book no-shows", "Follow up open sales opps", "Send reminder sequences"],
    inputs: ["GHL pipeline data", "Lead status tags", "DASH booking data"],
    outputs: ["Follow-up SMS/emails sent", "Re-book sequences triggered", "Updated lead tags"],
    connects: ["AUTO", "DASH", "CMMS"],
    trigger: "9am and 2pm daily",
  },
  {
    id: 7, name: "CRTV", color: "#FB923C", homeRoom: "creatives",
    role: "Creative Builder",
    tasks: ["Generate ad creative concepts", "Write Reels/TikTok scripts", "Build hook variations", "Package campaign assets"],
    inputs: ["COPY agent output", "Niche/offer context", "META winning creative data"],
    outputs: ["Script packages", "Hook variations", "Creative briefs", "Campaign asset bundles"],
    connects: ["COPY", "META", "STRT"],
    trigger: "Triggered by COPY completing + new campaigns",
  },
  {
    id: 8, name: "STRT", color: "#E879F9", homeRoom: "strategy",
    role: "Strategy Analyst",
    tasks: ["Analyse offer performance", "Research niche angles", "Review competitor positioning", "Surface strategic recommendations"],
    inputs: ["DASH data", "META performance data", "Client niche context", "Web research"],
    outputs: ["Positioning recommendations", "Offer angle reports", "Niche analysis docs", "Strategic briefs"],
    connects: ["DASH", "COPY", "CRTV", "OPS"],
    trigger: "Weekly deep analysis + on demand",
  },
  {
    id: 9, name: "OPS", color: "#2DD4BF", homeRoom: "ops",
    role: "Operations Agent",
    tasks: ["Monitor webhook failures", "Resolve sync issues", "Fix broken automations", "Handle cross-agent blockers"],
    inputs: ["Error logs from AUTO", "GHL API alerts", "DASH flags"],
    outputs: ["Issue resolution reports", "Fixed workflows", "Escalation alerts to Sam"],
    connects: ["AUTO", "DASH", "ALL"],
    trigger: "Always on — event driven",
  },
  {
    id: 10, name: "CMMS", color: "#F472B6", homeRoom: "comms",
    role: "Client Comms Agent",
    tasks: ["Draft client replies", "Handle delivery updates", "Manage escalations", "Chase client assets/info"],
    inputs: ["GHL client data", "Delivery status from OPS", "FLUP handoffs"],
    outputs: ["Drafted replies", "Delivery updates sent", "Escalation alerts"],
    connects: ["OPS", "FLUP", "AUTO", "CSM"],
    trigger: "Triggered by inbound client messages",
  },
  {
    id: 11, name: "CSM", color: "#5865F2", homeRoom: "csm",
    role: "Discord CSM Agent",
    tasks: ["Monitor all client Discord channels", "Reply using knowledge base", "Send proactive delivery updates", "Ping Sam on escalations"],
    inputs: ["Discord API", "GHL client data via AUTO", "OPS delivery status", "CMMS handoffs"],
    outputs: ["Discord replies (< 2 min)", "Weekly Monday check-ins", "Escalation pings to Sam with full context"],
    connects: ["CMMS", "OPS", "DASH", "AUTO"],
    trigger: "Always on · Monday 9am proactive check-ins · Escalates to Sam if unresolvable",
  },
];

// ─── ROOM TASK FEEDS ────────────────────────────────────────────────
const ROOM_FEEDS = {
  ads:       ["Rewriting headline variants...", "Testing new offer angle...", "CTA rewrite complete ✓", "Flagging budget bleed on Ad Set 3...", "3 variants packaged ✓"],
  creatives: ["Building Reels hook...", "Scripting ad creative...", "Hook variation A/B ready ✓", "Generating thumbnail brief...", "Asset bundle packaged ✓"],
  pipeline:  ["Configuring workflow...", "Setting contact tags...", "New automation live ✓", "Snapshot deployed to sub-account ✓", "Webhook verified ✓"],
  leads:     ["Scoring 14 new leads...", "Show rate: 68% ✓", "Booking rate flagged low ⚠️", "6 follow-ups queued...", "Daily briefing sent ✓"],
  funnels:   ["Auditing step 2 drop-off...", "Rewriting page headline...", "CTA button fixed ✓", "Conversion up 4% ✓", "Funnel audit complete ✓"],
  comms:     ["Drafting client reply...", "Delivery update sent ✓", "Asset chase message sent...", "Escalation flagged to Sam ⚠️", "Client replied ✓"],
  strategy:  ["Analysing niche positioning...", "Competitor research running...", "Offer angle report ready ✓", "Brief sent to COPY ✓", "Weekly strategy doc updated ✓"],
  ops:       ["Webhook failure detected ⚠️", "Resolving GHL sync issue...", "Automation patched ✓", "Error log cleared ✓", "All systems nominal ✓"],
  csm:       ["Monitoring #client-updates...", "Reply sent in #onboarding ✓", "Proactive check-in sent ✓", "Escalation → Sam pinged ⚠️", "Asset chase sent in Discord ✓"],
};

// ─── CORRIDORS ──────────────────────────────────────────────────────
const CORRIDORS = [
  { from: "ads", to: "creatives" }, { from: "creatives", to: "pipeline" },
  { from: "leads", to: "funnels" }, { from: "funnels", to: "comms" },
  { from: "ads", to: "leads" },     { from: "pipeline", to: "comms" },
  { from: "strategy", to: "ops" },  { from: "ops", to: "csm" },
  { from: "funnels", to: "strategy" }, { from: "leads", to: "strategy" },
  { from: "comms", to: "csm" },
];

function getRoomCenter(roomId) {
  const r = ROOMS.find(r => r.id === roomId);
  if (!r) return { x: 350, y: 290 };
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

// ─── AGENT SPRITE ───────────────────────────────────────────────────
function AgentSprite({ agent }) {
  return (
    <div style={{
      position: "absolute",
      left: agent.x, top: agent.y,
      transform: "translate(-50%, -50%)",
      zIndex: 20,
      transition: "left 1.4s cubic-bezier(0.45,0,0.55,1), top 1.4s cubic-bezier(0.45,0,0.55,1)",
      pointerEvents: "none",
    }}>
      <div style={{ position: "relative" }}>
        {/* Shadow */}
        <div style={{
          position: "absolute", bottom: -5, left: "50%", transform: "translateX(-50%)",
          width: 18, height: 5, borderRadius: "50%",
          background: "rgba(0,0,0,0.5)", filter: "blur(2px)",
        }} />
        {/* Body */}
        <div style={{
          width: 22, height: 22, borderRadius: "50% 50% 38% 38%",
          background: `radial-gradient(circle at 35% 30%, ${agent.color}ff, ${agent.color}77)`,
          border: `2px solid ${agent.color}`,
          boxShadow: `0 0 12px ${agent.color}66`,
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: "agentBob 0.55s ease-in-out infinite alternate",
        }}>
          <div style={{
            width: 9, height: 6, borderRadius: 3,
            background: "rgba(210,245,255,0.9)",
            marginTop: -2,
          }} />
        </div>
        {/* Carrying indicator */}
        {agent.carrying && (
          <div style={{
            position: "absolute", top: 0, right: -10,
            fontSize: 8, animation: "pulse 0.7s ease infinite",
          }}>📦</div>
        )}
        {/* Name */}
        <div style={{
          position: "absolute", top: 25, left: "50%", transform: "translateX(-50%)",
          fontSize: 7, color: agent.color, fontFamily: "'DM Mono', monospace",
          fontWeight: 700, whiteSpace: "nowrap",
          textShadow: `0 0 8px ${agent.color}`,
        }}>{agent.name}</div>
      </div>
    </div>
  );
}

// ─── ROOM PANEL ─────────────────────────────────────────────────────
function RoomPanel({ room, agents, onClose }) {
  const [feed, setFeed] = useState([]);
  const roomAgents = agents.filter(a => a.currentRoom === room.id);
  const agentDefs = roomAgents.map(a => AGENT_DEFS.find(d => d.name === a.name)).filter(Boolean);

  useEffect(() => {
    const tasks = ROOM_FEEDS[room.id] || [];
    setFeed([{ text: tasks[0], ts: new Date() }]);
    let i = 0;
    const iv = setInterval(() => {
      i = (i + 1) % tasks.length;
      setFeed(p => [{ text: tasks[i], ts: new Date() }, ...p].slice(0, 8));
    }, 1600);
    return () => clearInterval(iv);
  }, [room.id]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 300,
      background: "rgba(0,0,0,0.75)", backdropFilter: "blur(10px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onClose}>
      <div style={{
        background: "#0A0E14",
        border: `2px solid ${room.color}44`,
        borderRadius: 20, padding: 28, width: 520,
        boxShadow: `0 0 80px ${room.color}18`,
        animation: "panelIn 0.2s ease",
        maxHeight: "85vh", overflowY: "auto",
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <span style={{ fontSize: 26 }}>{room.icon}</span>
            {room.discord && <span style={{ marginLeft: 6, fontSize: 12, color: "#5865F2", background: "#5865F222", border: "1px solid #5865F244", borderRadius: 6, padding: "2px 8px" }}>Discord</span>}
            <h2 style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 20, color: "#fff", marginTop: 4 }}>{room.name}</h2>
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "1px solid #222", color: "#555",
            borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 11,
          }}>✕</button>
        </div>

        {/* Agents in room */}
        {agentDefs.map(agent => (
          <div key={agent.id} style={{
            background: agent.color + "0C",
            border: `1px solid ${agent.color}33`,
            borderRadius: 14, padding: "16px 18px", marginBottom: 14,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: agent.color, boxShadow: `0 0 6px ${agent.color}` }} />
              <div>
                <span style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, color: agent.color, fontSize: 14 }}>{agent.name}</span>
                <span style={{ color: "#555", fontSize: 11, marginLeft: 8 }}>{agent.role}</span>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 11 }}>
              <div>
                <div style={{ color: "#444", letterSpacing: "0.1em", marginBottom: 5, fontSize: 9 }}>DAILY TASKS</div>
                {agent.tasks.map((t, i) => (
                  <div key={i} style={{ color: "#888", marginBottom: 3, display: "flex", gap: 5 }}>
                    <span style={{ color: agent.color }}>›</span>{t}
                  </div>
                ))}
              </div>
              <div>
                <div style={{ color: "#444", letterSpacing: "0.1em", marginBottom: 5, fontSize: 9 }}>OUTPUTS</div>
                {agent.outputs.map((o, i) => (
                  <div key={i} style={{ color: "#888", marginBottom: 3, display: "flex", gap: 5 }}>
                    <span style={{ color: "#34D399" }}>✓</span>{o}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 9, color: "#444" }}>CONNECTS TO:</span>
              {agent.connects.map((c, i) => (
                <span key={i} style={{
                  fontSize: 9, color: agent.color, background: agent.color + "15",
                  border: `1px solid ${agent.color}33`, borderRadius: 4, padding: "1px 6px",
                  fontFamily: "'DM Mono', monospace",
                }}>{c}</span>
              ))}
            </div>

            <div style={{ marginTop: 8, fontSize: 9, color: "#333", fontFamily: "'DM Mono', monospace" }}>
              ⏱ {agent.trigger}
            </div>
          </div>
        ))}

        {roomAgents.length === 0 && (
          <div style={{ color: "#333", fontSize: 12, textAlign: "center", padding: 20 }}>No agents currently in this room</div>
        )}

        {/* Live feed */}
        <div style={{ background: "#060A0F", borderRadius: 12, padding: 16, border: "1px solid #111", marginTop: 4 }}>
          <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.15em", marginBottom: 10 }}>LIVE ACTIVITY</div>
          {feed.map((f, i) => (
            <div key={i} style={{
              display: "flex", gap: 10, marginBottom: 7,
              opacity: 1 - i * 0.12,
              animation: i === 0 ? "logSlide 0.3s ease" : "none",
            }}>
              <span style={{ fontSize: 9, color: "#333", fontFamily: "'DM Mono'", paddingTop: 1, minWidth: 36 }}>
                {f.ts.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </span>
              <span style={{ fontSize: 11, color: i === 0 ? "#fff" : "#666", fontFamily: "'DM Mono'" }}>
                {i === 0 && <span style={{ color: room.color }}>▶ </span>}{f.text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────────
export default function AgentRoom() {
  const [agents, setAgents] = useState(
    AGENT_DEFS.map(a => {
      const c = getRoomCenter(a.homeRoom);
      return { ...a, x: c.x + (Math.random() - 0.5) * 50, y: c.y + (Math.random() - 0.5) * 35, currentRoom: a.homeRoom, carrying: false };
    })
  );
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [log, setLog] = useState([
    { text: "DASH agent: show rate 68% — briefing sent", color: "#34D399" },
    { text: "CSM agent replied in #client-updates", color: "#5865F2" },
    { text: "AUTO agent: pipeline snapshot deployed", color: "#00C2D4" },
    { text: "META agent flagged £340 budget bleed", color: "#FF6B35" },
  ]);
  const [taskCount, setTaskCount] = useState(2847);
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      setAgents(prev => {
        const idx = Math.floor(Math.random() * prev.length);
        const agent = prev[idx];
        // CSM always stays home
        if (agent.name === "CSM") return prev;
        const roomIds = ROOMS.map(r => r.id).filter(r => r !== "csm");
        const newRoom = roomIds[Math.floor(Math.random() * roomIds.length)];
        if (newRoom === agent.currentRoom) return prev;
        const c = getRoomCenter(newRoom);
        const carrying = Math.random() > 0.45;
        const updated = [...prev];
        updated[idx] = { ...agent, x: c.x + (Math.random()-0.5)*50, y: c.y + (Math.random()-0.5)*35, currentRoom: newRoom, carrying };
        const roomName = ROOMS.find(r => r.id === newRoom)?.name;
        setLog(l => [{ text: `${agent.name} → ${roomName}${carrying ? " 📦" : ""}`, color: agent.color }, ...l].slice(0, 10));
        setTaskCount(n => n + Math.floor(Math.random() * 3) + 1);
        return updated;
      });
    }, 1500);
    return () => clearInterval(iv);
  }, []);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:#060A0F;overflow:hidden;}
        @keyframes agentBob{from{transform:translateY(0)}to{transform:translateY(-2px)}}
        @keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.2)}}
        @keyframes panelIn{from{opacity:0;transform:scale(0.94) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}
        @keyframes logSlide{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
        @keyframes scanline{0%{top:-2px}100%{top:100vh}}
        .room-card{transition:all 0.2s ease;cursor:pointer;}
        .room-card:hover{filter:brightness(1.18);transform:scale(1.015);}
        ::-webkit-scrollbar{width:3px}
        ::-webkit-scrollbar-thumb{background:#1a1a1a;border-radius:2px}
      `}</style>

      <div style={{ height: "100vh", background: "#060A0F", fontFamily: "'Syne',sans-serif", color: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Scanline */}
        <div style={{ position: "fixed", left: 0, right: 0, height: 2, background: "linear-gradient(transparent,#00C2D40A,transparent)", animation: "scanline 9s linear infinite", pointerEvents: "none", zIndex: 99 }} />

        {/* HEADER */}
        <div style={{ padding: "12px 24px", borderBottom: "1px solid #0f0f0f", background: "#080C12", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 9, color: "#00C2D4", letterSpacing: "0.22em", marginBottom: 2 }}>ECHO GROWTH · AGENT HQ</div>
            <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: "-0.01em" }}>Operations Floorplan</div>
          </div>
          <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
            {[
              { label: "Agents", val: agents.length, color: "#34D399" },
              { label: "Rooms", val: ROOMS.length, color: "#00C2D4" },
              { label: "Tasks Today", val: taskCount.toLocaleString(), color: "#FBBF24" },
            ].map((s, i) => (
              <div key={i} style={{ textAlign: "center" }}>
                <div style={{ color: s.color, fontWeight: 800, fontSize: 17 }}>{s.val}</div>
                <div style={{ color: "#333", fontSize: 9, letterSpacing: "0.1em" }}>{s.label}</div>
              </div>
            ))}
            <div style={{ fontFamily: "'DM Mono',monospace", color: "#00C2D4", fontSize: 14, fontWeight: 500 }}>
              {time.toLocaleTimeString("en-GB")}
            </div>
          </div>
        </div>

        {/* BODY */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* FLOORPLAN */}
          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            {/* Grid bg */}
            <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(#00C2D405 1px,transparent 1px),linear-gradient(90deg,#00C2D405 1px,transparent 1px)", backgroundSize: "30px 30px" }} />

            {/* Corridor lines */}
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }}>
              {CORRIDORS.map((c, i) => {
                const f = getRoomCenter(c.from), t = getRoomCenter(c.to);
                return <line key={i} x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke="#ffffff07" strokeWidth={10} strokeDasharray="5 8" />;
              })}
            </svg>

            {/* Rooms */}
            {ROOMS.map(room => {
              const roomAgents = agents.filter(a => a.currentRoom === room.id);
              return (
                <div key={room.id} className="room-card"
                  onClick={() => setSelectedRoom(room)}
                  style={{
                    position: "absolute", left: room.x, top: room.y, width: room.w, height: room.h,
                    background: room.color + "0D",
                    border: `2px solid ${room.color}3A`,
                    borderRadius: 14, padding: "12px 14px",
                    display: "flex", flexDirection: "column", justifyContent: "space-between",
                    zIndex: 10,
                  }}>
                  <div>
                    <div style={{ fontSize: 16, marginBottom: 3 }}>{room.icon}{room.discord && <span style={{ marginLeft: 4, fontSize: 9, color: "#5865F2" }}>DISCORD</span>}</div>
                    <div style={{ fontWeight: 800, fontSize: 12, color: "#fff" }}>{room.name}</div>
                    <div style={{ fontSize: 9, color: "#444", marginTop: 2, fontFamily: "'DM Mono',monospace" }}>
                      {ROOM_FEEDS[room.id]?.[0]}
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", gap: 3 }}>
                      {roomAgents.map(a => (
                        <div key={a.id} style={{ width: 7, height: 7, borderRadius: "50%", background: a.color, boxShadow: `0 0 4px ${a.color}` }} />
                      ))}
                    </div>
                    <div style={{ fontSize: 9, color: room.color, background: room.color + "18", border: `1px solid ${room.color}33`, borderRadius: 5, padding: "2px 7px" }}>
                      {roomAgents.length} agent{roomAgents.length !== 1 ? "s" : ""}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Agent sprites */}
            {agents.map(a => <AgentSprite key={a.id} agent={a} />)}

            <div style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", fontSize: 9, color: "#222", letterSpacing: "0.15em" }}>
              CLICK ANY ROOM TO INSPECT
            </div>
          </div>

          {/* SIDEBAR */}
          <div style={{ width: 210, background: "#080C12", borderLeft: "1px solid #0f0f0f", padding: 18, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.15em", marginBottom: 14 }}>MOVEMENT LOG</div>
            <div style={{ flex: 1, overflowY: "auto", marginBottom: 16 }}>
              {log.map((entry, i) => (
                <div key={i} style={{ marginBottom: 10, borderLeft: `2px solid ${entry.color}55`, paddingLeft: 8, opacity: 1 - i * 0.08, animation: i === 0 ? "logSlide 0.3s ease" : "none" }}>
                  <div style={{ fontSize: 10, color: "#777", fontFamily: "'DM Mono',monospace", lineHeight: 1.5 }}>{entry.text}</div>
                </div>
              ))}
            </div>

            {/* Roster */}
            <div style={{ borderTop: "1px solid #0f0f0f", paddingTop: 14 }}>
              <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.15em", marginBottom: 10 }}>ROSTER</div>
              {agents.map(a => {
                const room = ROOMS.find(r => r.id === a.currentRoom);
                return (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: a.color, boxShadow: `0 0 4px ${a.color}`, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 9, color: a.color, fontFamily: "'DM Mono',monospace", fontWeight: 700 }}>{a.name}</div>
                      <div style={{ fontSize: 8, color: "#333", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{room?.name}</div>
                    </div>
                    {a.carrying && <span style={{ fontSize: 8 }}>📦</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {selectedRoom && <RoomPanel room={selectedRoom} agents={agents} onClose={() => setSelectedRoom(null)} />}
      </div>
    </>
  );
}
