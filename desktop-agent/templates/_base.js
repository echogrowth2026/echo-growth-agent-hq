// Shared helpers for every browser template. Templates should use
// these instead of calling page.click / page.type / page.waitForSelector
// directly so selector failures, timeouts, and screenshots are
// handled uniformly.

const fs = require("fs");
const path = require("path");

const ERROR_DIR = path.join(__dirname, "..", "logs", "errors");
function ensureErrorDir() {
  if (!fs.existsSync(ERROR_DIR)) fs.mkdirSync(ERROR_DIR, { recursive: true });
}

/**
 * Wait for the first matching selector to appear. Accepts one selector
 * or an array — returns the one that hit, or throws a labelled error.
 */
async function waitForAny(page, selectors, { timeout = 10_000, visible = false } = {}) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const start = Date.now();
  const perSelTimeout = Math.max(250, Math.floor(timeout / list.length));
  let lastErr = null;
  for (const sel of list) {
    if (Date.now() - start > timeout) break;
    try {
      await page.waitForSelector(sel, { timeout: perSelTimeout, visible });
      return sel;
    } catch (e) { lastErr = e; }
  }
  const tried = list.map(s => `"${s}"`).join(", ");
  throw new Error(`waitForAny failed — none of [${tried}] appeared within ${timeout}ms. ${lastErr?.message || ""}`.trim());
}

async function safeClick(page, selectors, { timeout = 10_000, delay = 40 } = {}) {
  const hit = await waitForAny(page, selectors, { timeout, visible: true });
  await page.click(hit, { delay });
  return hit;
}

async function safeType(page, selectors, text, { timeout = 10_000, perCharDelay = 12 } = {}) {
  const hit = await waitForAny(page, selectors, { timeout, visible: true });
  await page.focus(hit);
  // Human-like delay, slightly randomised so it's not a perfectly even
  // cadence (some sites flag typing on consistent tempo).
  for (const ch of String(text ?? "")) {
    await page.keyboard.type(ch, { delay: perCharDelay + Math.floor(Math.random() * 20) });
  }
  return hit;
}

async function screenshotOnError(page, templateName) {
  try {
    ensureErrorDir();
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(ERROR_DIR, `${templateName}_${ts}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch { return null; }
}

/**
 * Wrap a template run() body so every return path shares shape:
 * { success, result, error, durationMs, screenshotPath? }.
 *
 * Use:
 *   return await withResult(templateName, async () => {
 *     ... body ...
 *     return { result: {...} };
 *   }, { page });
 */
async function withResult(templateName, body, { page = null } = {}) {
  const started = Date.now();
  try {
    const { result = null } = (await body()) || {};
    return { success: true, result, error: null, durationMs: Date.now() - started };
  } catch (e) {
    const screenshotPath = page ? await screenshotOnError(page, templateName) : null;
    return {
      success: false,
      result: null,
      error: e.message || String(e),
      durationMs: Date.now() - started,
      ...(screenshotPath ? { screenshotPath } : {}),
    };
  }
}

/**
 * Deadline helper: race the given promise against a hard timeout.
 */
function withTimeout(promise, timeoutMs, label = "operation") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Find an already-open page whose URL matches a host substring, or
 * open a fresh page and navigate to the default URL. Reusing existing
 * pages matters for anything that relies on a logged-in session (GHL,
 * LinkedIn, Discord) — opening a new tab every run costs the auth
 * handshake each time.
 */
async function findOrOpenPage(browser, { hostMatch, defaultUrl }) {
  const pages = await browser.pages();
  const match = pages.find(p => {
    try { return hostMatch.test(p.url()); }
    catch { return false; }
  });
  if (match && !match.isClosed()) return match;
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  if (defaultUrl) await page.goto(defaultUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  return page;
}

/**
 * Find the first DOM element whose visible text equals the target
 * (case-insensitive, trimmed). Returns the element handle or null.
 * Runs inside page.evaluateHandle so we can click the actual node.
 */
async function findByText(page, { selector = "*", text, exact = true }) {
  return await page.evaluateHandle((sel, t, ex) => {
    const needle = (t || "").trim().toLowerCase();
    const nodes = Array.from(document.querySelectorAll(sel));
    const matcher = ex
      ? (n) => (n.textContent || "").trim().toLowerCase() === needle
      : (n) => (n.textContent || "").trim().toLowerCase().includes(needle);
    return nodes.find(matcher) || null;
  }, selector, text, exact);
}

module.exports = {
  waitForAny,
  safeClick,
  safeType,
  screenshotOnError,
  withResult,
  withTimeout,
  findOrOpenPage,
  findByText,
  ERROR_DIR,
};
