# xPanel 3.0 UI acceptance status

Status recorded 23 September 2026. This is development-branch evidence, not
permission to merge, submit to the Chrome Web Store or publish the extension.

## Passed with published one-fetch 0.1.2

- Immutable client/core/protocol Release URLs and SHA-512 lockfile integrity.
  All 18 public release files match the reviewed manifest/checksums; provenance
  was verified separately. See [release evidence](one-fetch-browser-0.1.2-acceptance.md).
- Type checking, lint, dependency-source tests and all unit/component suites;
  extension tests include 195 cases. Browser envelope negotiation fails closed,
  and signed target statuses are not confused with outer HTTP 200.
- Actual Node-backed Chromium workbench: target 201/302/404/503, policy error,
  repeated Set-Cookie, target timing, 20 MiB digest, overflow/partial protection,
  Stop, background continuation, service-worker termination and Popup recovery.
- Node UI also verifies exact UTF-8 JSON, repeated/encoded query, a selected
  binary file, multipart text/file and a one-second timeout retaining the last
  result. The latest repeat passed after adding cancellable capability-preflight
  progress and live cross-window execution adoption; Remote Stop acknowledgement
  was 62.0 ms.
- Production dependency audit passed after pinning YAML 2.8.3 and fflate 0.8.3.
  Bounded regression tests exercise deeply nested YAML and malformed ZIP64.
- Release packaging now requires a production CycloneDX dependency inventory
  bound to the commit and lockfile digest, including immutable one-fetch package
  distribution URLs and SHA-512 integrity. This is not the final main artifact.
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

Supabase full Chromium UI acceptance subsequently passed in
`xpanel-three-dbb9427172cb`, using the published 0.1.2 adapter and real MV3
workbench. Coverage includes selected files/multipart, exact query and JSON,
status-source separation, cookies, timing, 20 MiB/+1, an independently verified
wire truncation, timeout, Stop, closed-workbench completion, service-worker
termination, Popup recovery and cross-window cancellation. Cleanup verified
the temporary project, fixture and local credentials absent. Cloudflare's
post-fix full repeat remains open.

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
- Its local credential directory `xpanel-one-fetch-cloudflare-2r0WHY` was
  subsequently deleted by the user and its absence was verified.
- The test harness now waits for public Control routes before entering the
  locked verifier, uses a bounded read-only workers.dev propagation window and
  records the failing stage without arbitrary response/error contents.
- Repeat Cloudflare and Supabase UI acceptance after cleanup, including the
  remaining upload/multipart/timeout coverage. Retire the old Relay template
  and build tasks only after migration acceptance passes.

### Follow-up hosted attempts (23 September)

- `xp3-62886e0aa0b4`: actual Cloudflare UI reached signed statuses, cookies,
  timing and redirect, then hit the harness's old 40-second deadline during
  the 20 MiB case. The harness now honors the product's 60-second budget plus
  bounded report overhead. Guarded owner/revision cleanup and fixture inventory
  confirmed all cloud resources absent; user-deleted local credentials were
  checked absent. This run did not pass.
- `xpanel-three-06947e578fa9`: actual Supabase UI passed JSON/file/multipart,
  timeout and the 20 MiB digest case, but the next request did not start within
  the harness deadline. Preflight now exposes preparing/Stop and rejects late
  completion after cancellation. Cleanup confirmed the temporary Supabase
  project, synthetic Worker and credentials absent. Full hosted acceptance is
  still required; no media-center resources were used or restored.
- `xp3-38ad2a5203a1`: failed deployment verification before UI acceptance.
  Guarded recovery deleted the two Workers and D1; the independent fixture was
  separately deleted. User confirmed local credential deletion and a read-only
  check verified absence. Original failed receipts remain unchanged.
- `xp3-4760b14b6a13`: the first UI request received an unsigned workers.dev
  404 page, correctly displayed as an unverified intermediary response. Cloud
  and credential cleanup completed and absence was verified. A separate,
  bounded Gateway routing probe now requires the application's protocol
  rejection before starting UI tests; it sends no token or target metadata.
- `xp3-be1c8ab984f4`: passed upload/status/timing/20 MiB cases, but the ordinary
  Workers-hosted errored stream was normalized into a complete seven-byte
  response. The test did not represent a wire truncation, so the run failed.
  Its resources and credentials were deleted and absence verified.
- `xp3-f81e419b6750`: the replacement FixedLengthStream fixture first proved
  a real read failure with fourteen advertised bytes. UI status, payload,
  timing, 20 MiB/+1, truncation and Stop checks then passed. Background completion
  and recovery passed, but a second window opened during preflight missed the
  subsequent execution event. This product race is fixed with idle-observer
  adoption (without stealing locally pending tasks), regression tests and a
  new passing Node UI run. Cloud resources and credentials were deleted and
  absence verified. The original run remains failed pending a full repeat.
- `xp3-df378786aa92`: failed the deployment verifier's public Control route
  check before UI acceptance; subsequent read-only health/capabilities probes
  returned 200. After confirming the helper stopped and the exact deployment
  owner/revision, guarded cleanup deleted both Workers and D1. The synthetic
  fixture was separately deleted and absence verified. The original failed
  receipt is unchanged; local credential deletion requires user confirmation.
  Readiness now requires three consecutive successful public-route probes,
  including a regression test for intermittent provider responses.

Failed runs and their cleanup follow-ups are not evidence of passed acceptance.

No media-center restore, retained public Gateway, xPanel merge or Store
submission was performed. Final main ZIP/SBOM and cloud UI acceptance remain
release gates, not implied by these checks.
