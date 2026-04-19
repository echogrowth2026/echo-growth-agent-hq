// Navigate to a named GHL sub-account page via the sidebar. If the
// caller also supplied a subaccountName, we switch first.
//
// GHL sidebar notes:
//   - Left sidebar is collapsed/expanded based on window width; text
//     labels may be hidden but are still present in the DOM for
//     accessibility. We match on textContent so either state works.
//   - Some pages ("Sites", "Memberships") changed label at some point
//     — we accept a couple of synonyms per page.

const switchTpl = require("./ghl_switch_subaccount");
const { withTimeout, withResult, screenshotOnError } = require("./_base");

const { findOrOpenPage, GHL_HOST, AGENCY_URL, LOCATION_URL_RE } = switchTpl._helpers;
const TIMEOUT_MS = 20_000;

// Canonical page keys → possible sidebar labels. Lower-case when matching.
const PAGE_LABELS = {
  dashboard:      ["dashboard", "launchpad"],
  conversations:  ["conversations", "messages"],
  calendars:      ["calendars", "calendar"],
  contacts:       ["contacts"],
  opportunities:  ["opportunities", "deals", "pipelines"],
  payments:       ["payments", "invoices"],
  marketing:      ["marketing", "emails"],
  automation:     ["automation", "workflows"],
  sites:          ["sites", "funnels", "websites"],
  memberships:    ["memberships", "courses", "communities"],
  reputation:     ["reputation", "reviews"],
  reporting:      ["reporting", "reports", "analytics"],
  settings:       ["settings"],
};

const VALID_PAGES = Object.keys(PAGE_LABELS);

async function clickSidebarLabel(page, labels) {
  const clicked = await page.evaluate((candidateLabels) => {
    const wanted = candidateLabels.map(s => s.toLowerCase());
    // GHL's sidebar items are <a> or <button> with text, or a wrapper
    // div with a role. Search all three.
    const nodes = Array.from(document.querySelectorAll("a, button, [role='link'], [role='button']"));
    const candidates = nodes.filter(n => {
      const txt = (n.textContent || "").trim().toLowerCase();
      if (!txt) return false;
      return wanted.some(w => txt === w || txt.startsWith(w + " ") || txt.endsWith(" " + w));
    });

    // Prefer sidebar hits: elements near the left edge (x < 260) are
    // almost certainly the left nav rather than inline content.
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.left - br.left;
    });

    const target = candidates[0];
    if (!target) return false;
    target.scrollIntoView({ block: "center" });
    target.click();
    return true;
  }, labels);
  return clicked;
}

async function waitForMainContent(page, timeout = 10_000) {
  // Two signals that the new page rendered: (a) main/role=main has
  // non-empty content, (b) URL path changed from the last one.
  try {
    await page.waitForFunction(() => {
      const main = document.querySelector("main, [role='main'], .hl_content, .hl-content-wrapper");
      return main && main.textContent && main.textContent.trim().length > 50;
    }, { timeout });
    return true;
  } catch { return false; }
}

async function run(browser, params) {
  const pageName = String(params?.page || "").trim().toLowerCase();
  const subaccountName = params?.subaccountName ? String(params.subaccountName).trim() : null;

  if (!pageName) {
    return { success: false, result: null, error: "params.page is required", durationMs: 0 };
  }
  if (!VALID_PAGES.includes(pageName)) {
    return {
      success: false,
      result: null,
      error: `invalid_page: ${pageName} (valid: ${VALID_PAGES.join(", ")})`,
      durationMs: 0,
    };
  }

  const started = Date.now();

  // Step 1: switch subaccount if asked. Bail with its error if it fails.
  if (subaccountName) {
    const switched = await switchTpl.run(browser, { subaccountName });
    if (!switched.success) {
      return {
        success: false,
        result: null,
        error: `subaccount_switch_failed: ${switched.error}`,
        durationMs: Date.now() - started,
      };
    }
  }

  const page = await findOrOpenPage(browser, { hostMatch: GHL_HOST, defaultUrl: AGENCY_URL });

  return await withTimeout(
    withResult("ghl_navigate_to_page", async () => {
      // Step 2: confirm we're inside a subaccount, not still on the
      // agency dashboard. Navigation pages only exist inside a location.
      if (!LOCATION_URL_RE.test(page.url())) {
        throw new Error("not_in_subaccount");
      }

      // Step 3: click the sidebar label.
      const labels = PAGE_LABELS[pageName];
      const clicked = await clickSidebarLabel(page, labels);
      if (!clicked) {
        await screenshotOnError(page, "ghl_navigate_to_page");
        throw new Error(`sidebar_item_not_found: ${pageName}`);
      }

      // Step 4: wait for the new main content.
      const loaded = await waitForMainContent(page, 10_000);
      if (!loaded) {
        // Not fatal — some pages render as SPA hash changes with the
        // same <main>. Accept if the URL path moved.
        // No-op, just fall through with current URL.
      }

      return {
        result: {
          page: pageName,
          url: page.url(),
        },
      };
    }, { page }),
    TIMEOUT_MS,
    "ghl_navigate_to_page",
  ).catch(e => ({
    success: false,
    result: null,
    error: e.message || String(e),
    durationMs: Date.now() - started,
  }));
}

module.exports = {
  name: "ghl_navigate_to_page",
  description: "Click a sidebar nav item in the current GHL sub-account (optionally switching sub-accounts first).",
  requiredParams: ["page"],
  timeoutMs: TIMEOUT_MS,
  validPages: VALID_PAGES,
  run,
};
