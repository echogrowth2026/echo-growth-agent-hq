// STUB — not yet implemented. Creates a new funnel from scratch or
// from one of GHL's built-in templates.
//
// TODO when fleshing out:
//   1. If params.subaccountName → ghl_switch_subaccount first.
//   2. Navigate: Sites / Funnels page. Use ghl_navigate_to_page with
//      page: "sites". The URL ends up /v2/location/<id>/funnels.
//   3. Click "+ New Funnel". Selectors:
//        - button[aria-label*="new funnel" i]
//        - button with text "+ New" or "Create Funnel"
//   4. A template picker modal appears IF params.template is set:
//        - use findByText on the template card whose name matches
//        - otherwise click "Start from scratch" / "Blank funnel"
//   5. A name input appears. Fill params.name.
//   6. Click Create / Next. Wait for editor to load (URL contains
//      /funnels/<newId>/pages or similar).
//   7. Extract the new funnel id from the URL.
//   8. Return { success: true, result: { funnelId, name, template, url } }
//
// Error cases:
//   - template not in picker list → "template_not_found: <name>"
//   - funnel name already exists → GHL toasts; surface that message
//   - editor fails to load → "editor_load_failed"
//
// Out of scope for this template: adding pages, sections, or
// elements to the funnel. Keep this to "create the shell". A
// separate template can populate it.

const TIMEOUT_MS = 60_000;

async function run(/* browser, params */) {
  return {
    success: false,
    result: null,
    error: "NOT_IMPLEMENTED: needs selectors for funnel picker modal + template card matching + name input + editor load signal",
    durationMs: 0,
  };
}

module.exports = {
  name: "ghl_build_funnel",
  description: "STUB — create a new funnel in the active GHL sub-account.",
  requiredParams: ["name"],
  timeoutMs: TIMEOUT_MS,
  run,
};
