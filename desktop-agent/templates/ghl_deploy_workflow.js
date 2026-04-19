// STUB — not yet implemented. Deploys an n8n-style workflow JSON
// into GHL's Automation Workflows.
//
// REALITY CHECK: GHL does not accept a JSON import for workflows the
// way n8n does. Options:
//   (a) Paste via hidden textarea — GHL's workflow editor accepts
//       clipboard JSON in some newer versions; needs probing.
//   (b) Translate our workflow spec into a sequence of clicks
//       (add trigger → configure → add step → configure → save).
//       Slow but reliable.
//
// TODO when fleshing out:
//   1. If params.subaccountName → ghl_switch_subaccount first.
//   2. ghl_navigate_to_page with page: "automation".
//   3. Click "+ New Workflow" / "Create Workflow".
//   4. Choose "Start from scratch" (avoid templates to keep behaviour
//      deterministic).
//   5. Name the workflow (if params.workflowJson.name present).
//   6. FOR EACH step in params.workflowJson.steps:
//        - click "+" on the canvas
//        - find step type (trigger/action/if/wait) in the palette
//        - click to add
//        - fill its fields (selectors are dynamic per step type —
//          expect a dedicated handler map per step type)
//   7. Click "Publish" / "Save".
//   8. Verify toast "Workflow saved".
//   9. Return { success, result: { workflowId, name, stepCount } }
//
// Consider also: a simpler first cut that only handles trigger-only
// workflows (webhook → nothing), proving the pattern before
// supporting every step type. Ask Sam before going deep.

const TIMEOUT_MS = 120_000;

async function run(/* browser, params */) {
  return {
    success: false,
    result: null,
    error: "NOT_IMPLEMENTED: GHL has no direct JSON import for workflows. Needs per-step-type click sequencer OR clipboard-paste discovery.",
    durationMs: 0,
  };
}

module.exports = {
  name: "ghl_deploy_workflow",
  description: "STUB — deploy a structured workflow spec into the active GHL sub-account's Automation.",
  requiredParams: ["workflowJson"],
  timeoutMs: TIMEOUT_MS,
  run,
};
