// STUB — not yet implemented. Applies a GHL snapshot (bundle of
// funnels/workflows/triggers/pipelines/etc) to the active sub-account.
//
// TODO when fleshing out:
//   1. If params.subaccountName → ghl_switch_subaccount first.
//   2. Agency-level prerequisite: the snapshot must already be saved
//      at agency scope and visible in the sub-account's snapshot
//      menu. This template does NOT handle snapshot creation — only
//      application.
//   3. Navigate to Settings → Snapshots inside the sub-account:
//        /v2/location/<id>/settings/snapshots
//      (path may be /settings/snapshot-load — verify on first run).
//   4. Find the snapshot by name in the list. Use findByText.
//   5. Click the "Apply"/"Load" button in that row.
//   6. A confirmation modal appears warning that snapshots can
//      overwrite data. Click "Confirm" / "Yes, apply".
//   7. Snapshots run async — a progress modal shows. Poll for:
//        - toast "Snapshot applied"
//        - progress bar hits 100%
//        - page refreshes
//   8. Return { success: true, result: { snapshotFile, locationId, appliedAt } }
//
// Error cases:
//   - snapshot not in list → "snapshot_not_found: <name>" (may mean
//     it needs sharing from agency first)
//   - apply fails mid-run → GHL toast message; relay verbatim
//   - timeout (some snapshots take 2-3 minutes) → extend timeout;
//     return "snapshot_apply_timeout" if > 5 min
//
// SAFETY: snapshot application is destructive. Require explicit
// confirmation before calling this — never fire from a casual Jarvis
// command without an are-you-sure step.

const TIMEOUT_MS = 300_000; // 5 minutes — snapshots can be slow

async function run(/* browser, params */) {
  return {
    success: false,
    result: null,
    error: "NOT_IMPLEMENTED: needs snapshot list matching + confirmation modal handling + async progress polling (GHL snapshots take 1-5 minutes)",
    durationMs: 0,
  };
}

module.exports = {
  name: "ghl_import_snapshot",
  description: "STUB — apply an agency snapshot to the active GHL sub-account.",
  requiredParams: ["snapshotFile"],
  timeoutMs: TIMEOUT_MS,
  run,
};
