const connStatus = document.getElementById("conn-status");
const wsUrlEl = document.getElementById("ws-url");
const authStateEl = document.getElementById("auth-state");
const browserStateEl = document.getElementById("browser-state");
const lastSeenEl = document.getElementById("last-seen");
const logEl = document.getElementById("log");

function renderLog(entries) {
  logEl.innerHTML = "";
  for (const e of entries) {
    const li = document.createElement("li");
    const ts = new Date(e.ts).toLocaleTimeString("en-GB");
    li.innerHTML = `<span class="ts">${ts}</span><span class="ev">${e.event}</span><span class="detail">${e.detail || ""}</span>`;
    logEl.appendChild(li);
  }
}

function prependLog(entry) {
  const li = document.createElement("li");
  const ts = new Date(entry.ts).toLocaleTimeString("en-GB");
  li.innerHTML = `<span class="ts">${ts}</span><span class="ev">${entry.event}</span><span class="detail">${entry.detail || ""}</span>`;
  logEl.insertBefore(li, logEl.firstChild);
  while (logEl.children.length > 80) logEl.removeChild(logEl.lastChild);
}

window.echo.onStatus((s) => {
  connStatus.textContent = s.connected ? (s.authenticated ? "online" : "handshake") : "offline";
  connStatus.className = "status " + (s.connected ? (s.authenticated ? "online" : "pending") : "");
  authStateEl.textContent = s.authenticated ? "✓ authenticated" : (s.connected ? "awaiting…" : "—");
  browserStateEl.textContent = s.browser?.running ? `running · ${s.browser.pages?.join(", ") || "idle"}` : "not launched";
  lastSeenEl.textContent = s.lastSeen ? new Date(s.lastSeen).toLocaleTimeString("en-GB") : "—";
});

window.echo.onLog((entry) => prependLog(entry));

window.echo.getInitialState().then((state) => {
  wsUrlEl.textContent = state.wsUrl;
  renderLog(state.log || []);
});

document.querySelectorAll("button[data-svc]").forEach(btn => {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try { await window.echo.quickOpen(btn.dataset.svc); }
    finally { btn.disabled = false; }
  });
});
