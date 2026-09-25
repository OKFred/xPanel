# xPanel 3.0.1 export fix

- Blank or invalid request URLs now produce actionable English/Chinese guidance
  inside the export dialog rather than a raw URL-constructor error.
- A saved collection can still be backed up with unfinished requests. Other
  formats identify an invalid saved request instead of silently dropping it.
- Failed exports clear the previous preview and disable copy/download. Older
  asynchronous response lookups cannot overwrite newer or sanitized previews.
- No new permissions, storage migration, remote protocol or dependency changes.
  one-fetch client/core/protocol remain fixed to the 0.1.2 Release artifacts.

Regression coverage includes component/unit tests and the actual Chromium
export flow. Release preparation also tests upgrades from immutable 2.1.0 and
3.0.0 builds, preserving saved collections, favorites and runtime permissions.

The 3.0.0 Store ZIP remains immutable. The 3.0.1 ZIP must be generated from the
final clean main commit after checks. Store upload, review submission and
publication are separate actions; this patch does not perform them.
