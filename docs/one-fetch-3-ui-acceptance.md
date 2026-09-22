# xPanel 3.0 UI acceptance status

Status recorded 22 September 2026. This is development-branch evidence, not
permission to merge, submit to the Chrome Web Store or publish the extension.

## Passed with published one-fetch 0.1.2

- Immutable client/core/protocol Release URLs and SHA-512 lockfile integrity.
  All 18 public release files match the reviewed manifest/checksums; provenance
  was verified separately. See [release evidence](one-fetch-browser-0.1.2-acceptance.md).
- Type checking, lint, dependency-source tests and all unit/component suites;
  extension tests include 191 cases. Browser envelope negotiation fails closed,
  and signed target statuses are not confused with outer HTTP 200.
- Actual Node-backed Chromium workbench: target 201/302/404/503, policy error,
  repeated Set-Cookie, target timing, 20 MiB digest, overflow/partial protection,
  Stop, background continuation, service-worker termination and Popup recovery.
- Actual 2.1.0 to 3.0.0 Chromium update: stable extension ID, no new permissions,
  enabled runtime, selectable collection/favorite, disabled and explicitly
  removable legacy profiles, preserved IndexedDB v2 and restart orphan recovery.
- Full `pnpm check`, including static MV3/permissions/source/history audit,
  production builds, asset dimensions and concise bilingual listing gate.
- Six bilingual 1280x800 screenshots regenerated from the standalone workbench
  and visually reviewed. Capture waits for Chrome's transient resize overlay to
  disappear; screenshots are not retouched. Browser E2E passed again during
  capture, including focus/console checks and background Stop (19.0 ms).

## Hosted UI gates still open

The three-platform official-client probes passed before publication, but they
do not substitute for full xPanel UI acceptance with the released dependencies.

- Cloudflare run `xp3-dfe8ab1bcba1` failed at synthetic fixture readiness (404).
  Its cloud resources and local credential directory were removed and verified.
- Run `xp3-88d9f25e6b50` reached installed services, then Control verification
  failed before UI acceptance. The deployment verifier retained its lock. After
  checking the exact owner/revision and confirming the helper had stopped, the
  guarded cleanup removed both Workers and D1. A transient D1 authentication
  error required a new read-only ownership check before guarded recovery.
  The independent synthetic Worker was also deleted and absence verified.
  Original failed receipts remain unchanged; this follow-up does not mark
  either run as passed.
- Its local credential directory `xpanel-one-fetch-cloudflare-2r0WHY` still
  requires user deletion because the execution policy rejected local removal.
- The test harness now waits for public Control routes before entering the
  locked verifier, uses a bounded read-only workers.dev propagation window and
  records the failing stage without arbitrary response/error contents.
- Repeat Cloudflare and Supabase UI acceptance after cleanup, including the
  remaining upload/multipart/timeout coverage. Retire the old Relay template
  and build tasks only after migration acceptance passes.

No media-center restore, retained public Gateway, xPanel merge or Store
submission was performed. Final main ZIP/SBOM and cloud UI acceptance remain
release gates, not implied by these checks.
