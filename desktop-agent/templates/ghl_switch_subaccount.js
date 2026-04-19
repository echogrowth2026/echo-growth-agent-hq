// Switch the active GHL sub-account from the agency dashboard.
// Reuses an already-open GHL tab if one exists; otherwise opens the
// agency dashboard. If we're currently inside a location, navigates
// out first (tries the back-to-agency control, falls back to a hard
// URL jump).
//
// GHL DOM notes (caveats at the top so future-me remembers):
//   - Agency dashboard lists sub-accounts either as a grid of cards
//     or rows. The markup has no stable class names — everything is
//     a Tailwind-ish hash. The only reliable anchors are:
//       · visible text (sub-account display name)
//       · a search/filter input near the top of the list
//       · URL transitions into /v2/location/<id>/ or /location/<id>/
//   - "Back to agency" control is top-left; icon + tooltip.
//   - The whole SPA re-renders on navigation, so selectors grabbed
//     before a click become detached — always re-query after nav.

const { findOrOpenPage, findByText, screenshotOnError, withTimeout, withResult } = require("./_base");

const AGENCY_URL = "https://app.gohighlevel.com/agency_dashboard";
const GHL_HOST = /gohighlevel\.com|leadconnector/i;
const LOCATION_URL_RE = /\/(?:v2\/)?location\/([a-zA-Z0-9]+)/i;
const TIMEOUT_MS = 30_000;

function extractLocationId(url) {
  const m = (url || "").match(LOCATION_URL_RE);
  return m ? m[1] : null;
}

async function ensureOnAgencyDashboard(page) {
  const url = page.url();
  if (/agency_dashboard/i.test(url)) return;

  // We're inside a subaccount — try the back-to-agency control first.
  if (LOCATION_URL_RE.test(url)) {
    const backSelectors = [
      'button[aria-label*="agency" i]',
      'a[href*="agency_dashboard"]',
      '[data-testid*="agency" i]',
    ];
    for (const sel of backSelectors) {
      try {
        const handle = await page.$(sel);
        if (handle) {
          await handle.click();
          await page.waitForFunction(
            () => /agency_dashboard/i.test(window.location.href),
            { timeout: 8_000 },
          ).catch(() => {});
          if (/agency_dashboard/i.test(page.url())) return;
        }
      } catch { /* try next */ }
    }
  }

  // Fallback: hard navigation. Same endpoint the back-button leads to.
  await page.goto(AGENCY_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
}

async function clickSubaccountByName(page, name) {
  // Strategy 1: type into a filter input if one exists. Narrows the
  // list so the click in strategy 2 is unambiguous.
  const searchSelectors = [
    'input[placeholder*="search" i]',
    'input[placeholder*="sub-account" i]',
    'input[placeholder*="subaccount" i]',
    'input[placeholder*="filter" i]',
    'input[type="search"]',
  ];
  for (const sel of searchSelectors) {
    try {
      const input = await page.$(sel);
      if (input) {
        await input.click({ clickCount: 3 });
        await page.keyboard.press("Backspace");
        await page.keyboard.type(name, { delay: 25 });
        // Give the list a moment to filter.
        await new Promise(r => setTimeout(r, 500));
        break;
      }
    } catch { /* try next */ }
  }

  // Strategy 2: find any clickable element whose visible text matches
  // the sub-account name. We try exact match first, then partial, and
  // we walk up to a clickable ancestor if the matched node itself
  // isn't a link/button.
  const clicked = await page.evaluate((targetName) => {
    const needle = targetName.trim().toLowerCase();
    const all = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, a, button, [role='button'], td, div, span, p"));
    const candidates = all.filter(n => {
      const txt = (n.textContent || "").trim().toLowerCase();
      if (!txt || txt.length > 200) return false;
      return txt === needle || txt.includes(needle);
    });

    // Prefer exact matches over partials.
    candidates.sort((a, b) => {
      const aExact = (a.textContent || "").trim().toLowerCase() === needle ? 0 : 1;
      const bExact = (b.textContent || "").trim().toLowerCase() === needle ? 0 : 1;
      return aExact - bExact;
    });

    for (const node of candidates) {
      // Walk up to the nearest clickable ancestor (card, row, link).
      let el = node;
      for (let i = 0; i < 6 && el; i++) {
        const isClickable =
          el.tagName === "A" ||
          el.tagName === "BUTTON" ||
          el.getAttribute?.("role") === "button" ||
          el.onclick ||
          window.getComputedStyle(el).cursor === "pointer";
        if (isClickable) {
          el.scrollIntoView({ block: "center" });
          el.click();
          return true;
        }
        el = el.parentElement;
      }
      // Fall back to clicking the text node itself.
      node.scrollIntoView({ block: "center" });
      node.click();
      return true;
    }
    return false;
  }, name);

  return clicked;
}

async function waitForSubaccountLoaded(page, timeout = 15_000) {
  // Two signals: (a) URL contains /location/<id>, (b) sidebar with
  // the subaccount nav items appears. Either counts as success.
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (LOCATION_URL_RE.test(page.url())) return true;
    const sidebarPresent = await page.evaluate(() => {
      const labels = ["Dashboard", "Conversations", "Opportunities", "Contacts"];
      const navNodes = Array.from(document.querySelectorAll("a, button, [role='link']"));
      return labels.filter(lbl =>
        navNodes.some(n => (n.textContent || "").trim().toLowerCase() === lbl.toLowerCase())
      ).length >= 2;
    }).catch(() => false);
    if (sidebarPresent) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function run(browser, params) {
  const name = String(params?.subaccountName || "").trim();
  if (!name) {
    return { success: false, result: null, error: "params.subaccountName is required", durationMs: 0 };
  }

  const page = await findOrOpenPage(browser, { hostMatch: GHL_HOST, defaultUrl: AGENCY_URL });

  return await withTimeout(
    withResult("ghl_switch_subaccount", async () => {
      await ensureOnAgencyDashboard(page);

      // Confirm the subaccount list rendered before clicking.
      const listReady = await page.waitForFunction(
        () => document.querySelectorAll("a, button, [role='button']").length > 10,
        { timeout: 10_000 },
      ).then(() => true).catch(() => false);

      if (!listReady) {
        await screenshotOnError(page, "ghl_switch_subaccount");
        throw new Error("subaccount_switcher_not_found");
      }

      const clicked = await clickSubaccountByName(page, name);
      if (!clicked) {
        await screenshotOnError(page, "ghl_switch_subaccount");
        throw new Error(`subaccount_not_found: ${name}`);
      }

      const loaded = await waitForSubaccountLoaded(page, 15_000);
      if (!loaded) {
        await screenshotOnError(page, "ghl_switch_subaccount");
        throw new Error("click_failed");
      }

      const url = page.url();
      return {
        result: {
          subaccountName: name,
          locationId: extractLocationId(url),
          url,
        },
      };
    }, { page }),
    TIMEOUT_MS,
    "ghl_switch_subaccount",
  ).catch(e => ({
    success: false,
    result: null,
    error: e.message || String(e),
    durationMs: TIMEOUT_MS,
  }));
}

module.exports = {
  name: "ghl_switch_subaccount",
  description: "Switch the active GHL sub-account via the agency dashboard.",
  requiredParams: ["subaccountName"],
  timeoutMs: TIMEOUT_MS,
  run,
  // Export helpers so ghl_navigate_to_page can reuse the same page
  // resolver without re-opening a second GHL tab.
  _helpers: { findOrOpenPage, GHL_HOST, AGENCY_URL, LOCATION_URL_RE, extractLocationId, waitForSubaccountLoaded },
};
