// Publishes a LinkedIn feed post using an existing logged-in session.
// Relies on the persistent userDataDir in config.browser; if LinkedIn
// logs you out, run LOGIN via Jarvis (or open LinkedIn from the tray)
// and finish auth manually once. Selectors are fragile — LinkedIn
// rewrites their UI regularly, expect to revisit.

const { safeClick, safeType, waitForAny, withResult, withTimeout } = require("./_base");

const FEED_URL = "https://www.linkedin.com/feed/";
const TIMEOUT_MS = 30_000;

// Selector lists — we try each until one hits. Order matters: put
// the most stable first.
const START_POST_SELECTORS = [
  "button.share-box-feed-entry__trigger",
  "button[aria-label*='Start a post' i]",
  "button[aria-label*='Create a post' i]",
  "div.share-box__open",
];

const EDITOR_SELECTORS = [
  "div.ql-editor[contenteditable='true']",
  "div[role='textbox'][contenteditable='true']",
  "[data-placeholder*='What do you want to talk about' i]",
];

const POST_BUTTON_SELECTORS = [
  "button.share-actions__primary-action:not([disabled])",
  "button[aria-label='Post']:not([disabled])",
  "button[data-control-name='share.post']:not([disabled])",
];

// When the modal closes after a successful post, the composer
// disappears. We detect success by the editor selector going away.
async function waitForComposerGone(page, timeout = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const stillThere = await page.$(EDITOR_SELECTORS[0]).catch(() => null);
    if (!stillThere) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("post modal didn't close — click may have failed silently");
}

async function run(browser, params) {
  const text = String(params?.text ?? "").trim();
  if (!text) {
    return { success: false, result: null, error: "params.text is required", durationMs: 0 };
  }
  if (params?.mediaUrl) {
    console.log("[linkedin_post] media not yet supported — ignoring mediaUrl");
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  return await withTimeout(
    withResult("linkedin_post", async () => {
      await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });

      // 1. Open composer.
      await safeClick(page, START_POST_SELECTORS, { timeout: 10_000 });

      // 2. Wait for editor, then type.
      await safeType(page, EDITOR_SELECTORS, text, { timeout: 10_000, perCharDelay: 12 });

      // 3. Give LinkedIn a beat to enable the Post button (it validates
      //    async after typing finishes).
      await new Promise(r => setTimeout(r, 600));

      // 4. Click Post.
      await safeClick(page, POST_BUTTON_SELECTORS, { timeout: 8_000 });

      // 5. Confirm modal closed — otherwise the post didn't actually go.
      await waitForComposerGone(page, 10_000);

      return { result: { postedAt: new Date().toISOString(), chars: text.length } };
    }, { page }),
    TIMEOUT_MS,
    "linkedin_post",
  ).catch(e => ({
    success: false,
    result: null,
    error: e.message || String(e),
    durationMs: TIMEOUT_MS,
  })).finally(async () => {
    // Leave the page open so Sam can see what happened — closing
    // interferes with the "did it post?" visual confirmation.
    // If we ever want a headless variant, close here.
  });
}

module.exports = {
  name: "linkedin_post",
  description: "Publish a LinkedIn feed post using the logged-in desktop browser session.",
  requiredParams: ["text"],
  timeoutMs: TIMEOUT_MS,
  run,
};
