// STUB — not yet implemented. Adds tag(s) to an existing GHL contact.
//
// TODO when fleshing out:
//   1. If params.subaccountName → ghl_switch_subaccount first.
//   2. Navigate directly to the contact detail page by URL:
//        https://app.gohighlevel.com/v2/location/<locationId>/contacts/detail/<contactId>
//      Easier than clicking into the contact from the list.
//   3. Find the Tags chip input on the contact's profile. Selectors to try:
//        - input[placeholder*="tag" i]
//        - element under a label "Tags" (use findByText with selector "label")
//        - a .vs__search inside a chip component
//   4. For each tag in params.tags:
//        - focus input, type tag, press Enter
//        - GHL may auto-suggest — if the suggestion dropdown is
//          visible, use keyboard ArrowDown + Enter to pick the first
//          match instead of typing+Enter which creates a new tag.
//   5. No save button — tags persist as you add them. Wait ~500ms
//      between adds to avoid racing the chip render.
//   6. Confirm all tags appear as chips on the page (page.evaluate
//      checking each tag's text is present in chip elements).
//   7. Return { success: true, result: { contactId, tagsAdded: [...] } }
//
// Error cases:
//   - contactId not found in URL after nav → "contact_not_found"
//   - tag input not present → "tag_input_not_found"
//   - partial success → return success:true but include tagsAdded
//     showing which tags made it (don't lie about coverage).

const TIMEOUT_MS = 30_000;

async function run(/* browser, params */) {
  return {
    success: false,
    result: null,
    error: "NOT_IMPLEMENTED: needs tag chip input selector + dropdown suggestion handling + chip verification",
    durationMs: 0,
  };
}

module.exports = {
  name: "ghl_tag_contact",
  description: "STUB — add tag(s) to an existing contact in the active GHL sub-account.",
  requiredParams: ["contactId", "tags"],
  timeoutMs: TIMEOUT_MS,
  run,
};
