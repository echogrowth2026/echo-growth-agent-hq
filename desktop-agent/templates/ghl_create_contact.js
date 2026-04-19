// STUB — not yet implemented. Creates a new contact in the active
// GHL sub-account via the UI (not the API, so it works without an
// agency-level API token).
//
// TODO when fleshing out:
//   1. If params.subaccountName provided → await ghl_switch_subaccount first.
//   2. Call ghl_navigate_to_page with { page: "contacts" }.
//   3. Selector for "Add Contact" button:
//        - button with aria-label containing "add contact" (case-insens)
//        - button with text "+ Add" or "Add Contact"
//        - top-right of the contacts list (might be behind a "+" menu)
//   4. Modal form — fields to fill (expect dynamic classes; match by
//      input name/placeholder/label):
//        - input[name="firstName"] or placeholder containing "First"
//        - input[name="lastName"]  or placeholder containing "Last"
//        - input[type="email"]
//        - input[type="tel"] or placeholder "Phone" — only if params.phone
//   5. Tags field is a chip input — GHL's looks like:
//        - input under label "Tags" → type tag, press Enter, repeat
//   6. Submit: button text "Save", "Create", or "Add Contact"
//   7. Wait for: modal to close, OR toast "Contact created", OR URL
//      to contain /contacts/<newId>. Extract newId from URL if there.
//   8. Return { success: true, result: { contactId, firstName, ... } }.
//
// Error cases:
//   - duplicate email → GHL shows a toast "Contact already exists"; surface that
//   - missing required fields → return "missing_field: <name>"

const TIMEOUT_MS = 45_000;

async function run(/* browser, params */) {
  return {
    success: false,
    result: null,
    error: "NOT_IMPLEMENTED: needs selectors for Add Contact modal + tag chip input + success toast detection",
    durationMs: 0,
  };
}

module.exports = {
  name: "ghl_create_contact",
  description: "STUB — create a new contact in the active GHL sub-account via the UI.",
  requiredParams: ["firstName", "lastName", "email"],
  timeoutMs: TIMEOUT_MS,
  run,
};
