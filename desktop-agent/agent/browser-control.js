// Local browser control via Puppeteer. Launches a visible Chromium
// with a dedicated userDataDir so cookies/sessions persist between
// runs — Sam logs in once per service and the session sticks.
//
// NOTE: Puppeteer cannot share the profile that Chrome is currently
// using. So the first time Sam logs in here he'll need to do it
// manually in the window that pops up. After that sessions persist.
//
// LinkedIn automation caveat: LinkedIn actively detects and restricts
// automated behaviour. Keep actions human-paced and don't loop.

const puppeteer = require("puppeteer");

let browser = null;
const pagesByService = {};

async function launch(cfg) {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: cfg.headless === true,
    defaultViewport: null,
    userDataDir: cfg.userDataDir,
    args: cfg.args || ["--start-maximized"],
  });
  browser.on("disconnected", () => { browser = null; for (const k of Object.keys(pagesByService)) delete pagesByService[k]; });
  return browser;
}

async function ensureBrowser(cfg) {
  if (!browser || !browser.isConnected()) await launch(cfg);
  return browser;
}

async function pageFor(service, cfg, services) {
  await ensureBrowser(cfg);
  if (pagesByService[service] && !pagesByService[service].isClosed()) return pagesByService[service];
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const url = services?.[service]?.url;
  if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  pagesByService[service] = page;
  return page;
}

async function openUrl(url, { service, cfg, services } = {}) {
  await ensureBrowser(cfg);
  const page = service ? await pageFor(service, cfg, services) : await browser.newPage();
  if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  return { success: true, title: await page.title(), url: page.url() };
}

// "Login" here is intentionally thin — it just navigates to the
// service's login URL so Sam finishes auth manually in the visible
// window. No credentials are passed over the wire. Once Sam logs in,
// the dedicated userDataDir keeps the session across runs.
async function loginService(service, { cfg, services }) {
  const url = services?.[service]?.url;
  if (!url) return { success: false, error: `unknown service: ${service}` };
  const page = await pageFor(service, cfg, services);
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  return { success: true, service, message: `Navigated to ${service}. Finish login in the browser window if needed.` };
}

async function screenshot(page, fullPage = false) {
  const buf = await page.screenshot({ fullPage, type: "png" });
  return buf.toString("base64");
}

// LinkedIn: paste content into composer, do NOT publish yet.
async function linkedinPastePost({ content, cfg, services }) {
  const page = await pageFor("linkedin", cfg, services);
  await page.goto(services.linkedin.url, { waitUntil: "domcontentloaded" }).catch(() => {});
  // Click "Start a post" — selectors vary; try a few.
  const starters = [
    "button.share-box-feed-entry__trigger",
    "button[aria-label*='Start a post']",
    "div.share-box__open",
  ];
  let opened = false;
  for (const sel of starters) {
    try { await page.waitForSelector(sel, { timeout: 6000 }); await page.click(sel); opened = true; break; }
    catch {}
  }
  if (!opened) return { success: false, error: "couldn't find LinkedIn post composer" };

  const editorSelectors = [
    "div.ql-editor",
    "[data-placeholder='What do you want to talk about?']",
    "div[role='textbox']",
  ];
  let pasted = false;
  for (const sel of editorSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      await page.click(sel);
      await page.keyboard.type(content, { delay: 8 });
      pasted = true;
      break;
    } catch {}
  }
  if (!pasted) return { success: false, error: "couldn't find LinkedIn composer editor" };

  const shot = await screenshot(page, false);
  return { success: true, stage: "pasted", screenshot: shot };
}

async function linkedinClickPost({ cfg, services }) {
  const page = await pageFor("linkedin", cfg, services);
  const postBtns = [
    "button.share-actions__primary-action",
    "button[aria-label='Post']",
    "button[data-control-name='share.post']",
  ];
  for (const sel of postBtns) {
    try {
      await page.waitForSelector(sel, { timeout: 4000 });
      await page.click(sel);
      return { success: true, stage: "published" };
    } catch {}
  }
  return { success: false, error: "couldn't find LinkedIn Post button" };
}

async function linkedinCancel({ cfg, services }) {
  const page = await pageFor("linkedin", cfg, services);
  try { await page.keyboard.press("Escape"); } catch {}
  return { success: true, stage: "cancelled" };
}

// n8n: import workflow JSON via the UI. Paste workflow JSON into the
// canvas (Ctrl+V) after opening a new workflow.
async function n8nImportWorkflow({ workflow, name, cfg, services }) {
  const page = await pageFor("n8n", cfg, services);
  // Best-effort; the selectors below target n8n cloud/self-hosted UIs
  // circa 2026. If they've moved, fall back to leaving the JSON on
  // the clipboard and letting Sam paste it.
  try {
    await page.goto(`${services.n8n.url.replace(/\/$/, "")}/workflow/new`, { waitUntil: "domcontentloaded" }).catch(() => {});
    const json = JSON.stringify(workflow || {});
    // Set clipboard via DOM so Ctrl+V works regardless of focus.
    await page.evaluate(async (payload) => {
      try { await navigator.clipboard.writeText(payload); } catch {}
    }, json);
    await page.keyboard.down("Control"); await page.keyboard.press("KeyV"); await page.keyboard.up("Control");
    const shot = await screenshot(page, false);
    return { success: true, stage: "imported", name: name || null, screenshot: shot };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function executeAction(action, { cfg, services }) {
  const svc = action.service || null;
  const page = svc ? await pageFor(svc, cfg, services) : (await browser.pages())[0];
  switch (action.type) {
    case "click":
      await page.click(action.selector); return { success: true };
    case "type":
      await page.type(action.selector, action.text || "", { delay: 10 }); return { success: true };
    case "navigate":
      await page.goto(action.url, { waitUntil: "domcontentloaded" }); return { success: true, title: await page.title() };
    case "screenshot":
      return { success: true, screenshot: await screenshot(page, !!action.fullPage) };
    case "waitForSelector":
      await page.waitForSelector(action.selector, { timeout: action.timeout || 10_000 }); return { success: true };
    case "evaluate":
      return { success: true, result: await page.evaluate(action.script) };
    case "paste-post":
      if (svc === "linkedin") return await linkedinPastePost({ content: action.content, cfg, services });
      return { success: false, error: `paste-post not supported for service ${svc}` };
    case "click-post":
      if (svc === "linkedin") return await linkedinClickPost({ cfg, services });
      return { success: false, error: `click-post not supported for service ${svc}` };
    case "cancel-post":
      if (svc === "linkedin") return await linkedinCancel({ cfg, services });
      return { success: false, error: `cancel-post not supported for service ${svc}` };
    case "import-workflow":
      if (svc === "n8n") return await n8nImportWorkflow({ workflow: action.workflow, name: action.name, cfg, services });
      return { success: false, error: `import-workflow not supported for service ${svc}` };
    case "plan-and-execute":
      return { success: false, error: "plan-and-execute requires human guidance — use more specific actions" };
    default:
      return { success: false, error: `unknown action type: ${action.type}` };
  }
}

async function takeScreenshot({ cfg }) {
  await ensureBrowser(cfg);
  const page = (await browser.pages())[0] || (await browser.newPage());
  return { success: true, screenshot: await screenshot(page, false) };
}

function status() {
  return {
    running: !!(browser && browser.isConnected()),
    pages: Object.keys(pagesByService),
  };
}

module.exports = { launch, openUrl, loginService, executeAction, takeScreenshot, status };
