// BROWSER MODULE — Puppeteer wrapper, scaffolding only.
//
// No agents call this yet. It's here so we can wire browser automation
// once we've confirmed Railway's Dockerfile is running Chromium
// correctly. Uses puppeteer-core (NOT puppeteer) so the npm install
// doesn't try to download Chromium on every deploy — we rely on
// PUPPETEER_EXECUTABLE_PATH pointing to the chromium package installed
// in the container.
//
// Usage (future):
//   import { getBrowser, getGHLPage, queueBrowserTask } from "./browser.js";
//   const page = await getGHLPage();
//   await page.goto(...);
//
// Safety: single browser instance, serialised task queue, every task
// is wrapped in try/finally so pages get closed even on failure.

import dotenv from "dotenv";
dotenv.config();

const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || null;
const GHL_EMAIL = process.env.GHL_EMAIL || null;
const GHL_PASSWORD = process.env.GHL_PASSWORD || null;

let puppeteer = null;
let browserInstance = null;
let ghlPage = null;
let queue = Promise.resolve();

async function loadPuppeteer() {
  if (puppeteer) return puppeteer;
  try {
    puppeteer = (await import("puppeteer-core")).default;
    return puppeteer;
  } catch (e) {
    console.warn(`[BROWSER] puppeteer-core not installed — browser module disabled. (${e.message})`);
    return null;
  }
}

export async function getBrowser() {
  if (browserInstance && browserInstance.isConnected?.()) return browserInstance;
  const pp = await loadPuppeteer();
  if (!pp) return null;
  if (!EXECUTABLE_PATH) {
    console.warn("[BROWSER] PUPPETEER_EXECUTABLE_PATH not set — cannot launch");
    return null;
  }
  browserInstance = await pp.launch({
    executablePath: EXECUTABLE_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-setuid-sandbox"],
  });
  browserInstance.on("disconnected", () => { browserInstance = null; ghlPage = null; });
  return browserInstance;
}

export async function getGHLPage() {
  const browser = await getBrowser();
  if (!browser) return null;
  if (ghlPage && !ghlPage.isClosed()) return ghlPage;

  ghlPage = await browser.newPage();
  await ghlPage.setViewport({ width: 1440, height: 900 });

  if (GHL_EMAIL && GHL_PASSWORD) {
    try {
      await ghlPage.goto("https://app.gohighlevel.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      // The real selectors will need verification once we flip this on.
      // Treat every selector as best-effort — future task.
      await ghlPage.type('input[type="email"]', GHL_EMAIL, { delay: 20 }).catch(() => {});
      await ghlPage.type('input[type="password"]', GHL_PASSWORD, { delay: 20 }).catch(() => {});
      await ghlPage.click('button[type="submit"]').catch(() => {});
      await ghlPage.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
      console.log("[BROWSER] GHL login attempted");
    } catch (e) {
      console.warn("[BROWSER] GHL login failed:", e.message);
    }
  }
  return ghlPage;
}

export function queueBrowserTask(agent, taskFn) {
  queue = queue.then(async () => {
    const started = Date.now();
    try {
      const result = await taskFn();
      console.log(`[BROWSER] ${agent} task ✓ (${Date.now() - started}ms)`);
      return result;
    } catch (e) {
      console.error(`[BROWSER] ${agent} task ✗:`, e.message);
      throw e;
    }
  });
  return queue;
}

export async function shutdownBrowser() {
  if (browserInstance) {
    try { await browserInstance.close(); } catch {}
    browserInstance = null;
    ghlPage = null;
  }
}

export function browserStatus() {
  return {
    executablePath: EXECUTABLE_PATH || null,
    running: !!(browserInstance && browserInstance.isConnected?.()),
    ghlCredentials: !!(GHL_EMAIL && GHL_PASSWORD),
  };
}
