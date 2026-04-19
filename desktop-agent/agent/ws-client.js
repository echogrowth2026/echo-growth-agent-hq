const WebSocket = require("ws");

let ws = null;
let stateSubscribers = new Set();
let currentState = { connected: false, authenticated: false, lastSeen: null };

function setState(patch) {
  currentState = { ...currentState, ...patch };
  for (const fn of stateSubscribers) { try { fn(currentState); } catch {} }
}

function onState(fn) { stateSubscribers.add(fn); fn(currentState); return () => stateSubscribers.delete(fn); }

function connect({ url, authToken, handlers, onEvent }) {
  ws = new WebSocket(url);

  ws.on("open", () => {
    setState({ connected: true, authenticated: !authToken, lastSeen: new Date().toISOString() });
    if (authToken) ws.send(JSON.stringify({ type: "auth", token: authToken }));
    onEvent?.({ event: "connected", detail: url });
  });

  ws.on("message", async (raw) => {
    setState({ lastSeen: new Date().toISOString() });
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "auth-ok") { setState({ authenticated: true }); return; }
    if (msg.type === "auth-fail") { setState({ authenticated: false }); console.error("[WS] auth failed"); return; }

    // All command types sent by the server are routed through handlers.
    const handler = handlers?.[msg.type];
    if (!handler) {
      ws.send(JSON.stringify({ type: "result", id: msg.id, result: { success: false, error: `unknown command type: ${msg.type}` } }));
      return;
    }
    try {
      const result = await handler(msg);
      ws.send(JSON.stringify({ type: "result", id: msg.id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "result", id: msg.id, result: { success: false, error: e.message } }));
    }
  });

  ws.on("close", () => {
    setState({ connected: false, authenticated: false });
    onEvent?.({ event: "disconnected" });
    setTimeout(() => connect({ url, authToken, handlers, onEvent }), 5000);
  });

  ws.on("error", (e) => {
    console.error("[WS] error:", e.message);
    onEvent?.({ event: "error", detail: e.message });
  });
}

function sendEvent(event, detail) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: "event", event, detail }));
  return true;
}

module.exports = { connect, onState, sendEvent };
