const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

const wsClient = require("./agent/ws-client");
const browser = require("./agent/browser-control");
const fileAccess = require("./agent/file-access");
const commandRunner = require("./agent/command-runner");

const CONFIG_PATH = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const authToken = process.env.DESKTOP_AUTH_TOKEN || config.authToken || null;
const wsUrl = process.env.RAILWAY_WS_URL || config.railwayWsUrl;

let mainWindow;
let tray;
const activityLog = []; // { ts, event, detail }

function pushLog(entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  activityLog.unshift(record);
  if (activityLog.length > 200) activityLog.pop();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("log", record);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 640,
    frame: false,
    transparent: false,
    backgroundColor: "#060A0F",
    alwaysOnTop: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function createTray() {
  // Use a 1x1 transparent png if no icon file is shipped — Electron
  // will fall back to a tiny dot rather than crash.
  const iconPath = path.join(__dirname, "icon.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Echo Desktop Agent");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show", click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: "Hide", click: () => mainWindow.hide() },
    { type: "separator" },
    { label: "Open GHL",      click: async () => { await browser.openUrl(config.services.ghl.url, { service: "ghl", cfg: config.browser, services: config.services }); } },
    { label: "Open n8n",      click: async () => { await browser.openUrl(config.services.n8n.url, { service: "n8n", cfg: config.browser, services: config.services }); } },
    { label: "Open LinkedIn", click: async () => { await browser.openUrl(config.services.linkedin.url, { service: "linkedin", cfg: config.browser, services: config.services }); } },
    { label: "Open Discord",  click: async () => { await browser.openUrl(config.services.discord.url, { service: "discord", cfg: config.browser, services: config.services }); } },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

// ─── COMMAND HANDLERS ───────────────────────────────────────────────
// One per server→desktop message type.
const handlers = {
  OPEN_URL: async (msg) => {
    pushLog({ event: "OPEN_URL", detail: msg.url || msg.service || "" });
    return await browser.openUrl(msg.url, { service: msg.service, cfg: config.browser, services: config.services });
  },
  LOGIN: async (msg) => {
    pushLog({ event: "LOGIN", detail: msg.service });
    return await browser.loginService(msg.service, { cfg: config.browser, services: config.services });
  },
  BROWSER_ACTION: async (msg) => {
    pushLog({ event: "BROWSER_ACTION", detail: `${msg.action?.service || ""} · ${msg.action?.type || ""}` });
    return await browser.executeAction(msg.action || {}, { cfg: config.browser, services: config.services });
  },
  SCREENSHOT: async () => {
    pushLog({ event: "SCREENSHOT" });
    return await browser.takeScreenshot({ cfg: config.browser });
  },
  READ_FILE: async (msg) => {
    pushLog({ event: "READ_FILE", detail: msg.path });
    return await fileAccess.readFile(msg.path, config.allowedDirs);
  },
  WRITE_FILE: async (msg) => {
    pushLog({ event: "WRITE_FILE", detail: msg.path });
    return await fileAccess.writeFile(msg.path, msg.content, config.allowedDirs);
  },
  LIST_DIR: async (msg) => {
    pushLog({ event: "LIST_DIR", detail: msg.path });
    return await fileAccess.listDir(msg.path, config.allowedDirs);
  },
  RUN_COMMAND: async (msg) => {
    pushLog({ event: "RUN_COMMAND", detail: msg.cmd });
    return await commandRunner.run(msg.cmd, {
      cwd: config.commandCwd,
      allowedPrefixes: config.allowedCommandPrefixes,
      blockedPatterns: config.blockedPatterns,
    });
  },
};

// ─── IPC for renderer ───────────────────────────────────────────────
ipcMain.handle("get-initial-state", async () => ({
  log: activityLog.slice(0, 50),
  browserRunning: browser.status().running,
  wsUrl,
  authRequired: !!authToken,
  services: Object.keys(config.services),
}));

ipcMain.handle("quick-open", async (_e, service) => {
  const url = config.services[service]?.url;
  if (!url) return { success: false, error: "unknown service" };
  pushLog({ event: "QUICK_OPEN", detail: service });
  return await browser.openUrl(url, { service, cfg: config.browser, services: config.services });
});

// ─── LIFECYCLE ──────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createWindow();
  createTray();

  await browser.launch(config.browser).catch((e) => {
    pushLog({ event: "browser_launch_failed", detail: e.message });
  });

  wsClient.onState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("status", {
      ...state,
      browser: browser.status(),
    });
  });

  wsClient.connect({
    url: wsUrl,
    authToken,
    handlers,
    onEvent: ({ event, detail }) => pushLog({ event, detail: detail || "" }),
  });
});

app.on("window-all-closed", (e) => { e.preventDefault(); /* keep running in tray */ });
