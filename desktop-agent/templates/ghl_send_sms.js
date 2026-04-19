// STUB — not yet implemented. Sends an SMS to a contact from the
// contact's Conversations panel.
//
// TODO when fleshing out:
//   1. If params.subaccountName → ghl_switch_subaccount first.
//   2. Navigate directly:
//        https://app.gohighlevel.com/v2/location/<locationId>/contacts/detail/<contactId>
//      Then click the Conversations tab, OR navigate to:
//        /v2/location/<id>/conversations/conversations/<conversationId>
//      if we have the conversation id (we usually won't).
//   3. Ensure the SMS channel is selected. Channel switcher shows
//      Email / SMS / WhatsApp icons below the message composer.
//        - Click the SMS icon (aria-label contains "SMS")
//   4. Find the composer textarea:
//        - textarea[placeholder*="type" i]
//        - [contenteditable='true'] within a class containing "composer"
//   5. Focus it, type params.message (keep the human-ish delay via
//      _base safeType).
//   6. Click Send:
//        - button[aria-label="send" i]
//        - button with text "Send"
//   7. Confirm: the message bubble appears in the thread within 5s
//      with the typed text.
//   8. Return { success: true, result: { contactId, channel: "sms", sentAt } }
//
// Error cases:
//   - SMS channel not available for contact (no phone) → GHL disables
//     the send button; detect and return "no_phone_for_contact"
//   - rate limited → GHL toast; surface the message
//   - message too long → GHL silently truncates; warn if > 160 chars
//
// SAFETY: SMS is a live, costing action. Consider gating behind a
// confirmation step when wired into Jarvis. Never loop.

const TIMEOUT_MS = 30_000;

async function run(/* browser, params */) {
  return {
    success: false,
    result: null,
    error: "NOT_IMPLEMENTED: needs SMS channel switcher selector + composer textarea + send button + message-bubble confirmation",
    durationMs: 0,
  };
}

module.exports = {
  name: "ghl_send_sms",
  description: "STUB — send an SMS to a contact from their Conversations panel.",
  requiredParams: ["contactId", "message"],
  timeoutMs: TIMEOUT_MS,
  run,
};
