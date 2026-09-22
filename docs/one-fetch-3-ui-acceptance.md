# xPanel 3.0 UI acceptance status

Status recorded 23 September 2026. This is development-branch evidence, not
permission to merge, submit to the Chrome Web Store or publish the extension.

## Passed with published one-fetch 0.1.2

- Immutable client/core/protocol Release URLs and SHA-512 lockfile integrity.
  All 18 public release files match the reviewed manifest/checksums; provenance
  was verified separately. See [release evidence](one-fetch-browser-0.1.2-acceptance.md).
- Type checking, lint, dependency-source tests and all unit/component suites;
  extension tests include 193 cases after retiring nine legacy-only cases;
  contracts/format-conversion/tooling suites add 44/19/11 cases.
  Browser envelope negotiation fails closed,
  and signed target statuses are not confused with outer HTTP 200.
- Actual Node-backed Chromium workbench: target 201/302/404/503, policy error,
  repeated Set-Cookie, target timing, 20 MiB digest, overflow/partial protection,
  Stop, background continuation, service-worker termination and Popup recovery.
- Node UI also verifies exact UTF-8 JSON, repeated/encoded query, a selected
  binary file, multipart text/file and a one-second timeout retaining the last
  result. The latest repeat passed after adding cancellable capability-preflight
  progress, live cross-window execution adoption and uncertain-body isolation;
  Remote Stop acknowledgement was 61.6 ms. The second window subscribed before
  the new request started, and the owned container was removed and checked absent.
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

## Three-platform UI sign-off

The three-platform official-client probes passed before publication, but they
do not substitute for full xPanel UI acceptance with the released dependencies.

Supabase full Chromium UI acceptance subsequently passed in
`xpanel-three-dbb9427172cb`, using the published 0.1.2 adapter and real MV3
workbench. Coverage includes selected files/multipart, exact query and JSON,
status-source separation, cookies, timing, 20 MiB/+1, an independently verified
wire truncation, timeout, Stop, closed-workbench completion, service-worker
termination, Popup recovery and cross-window cancellation. Cleanup verified
the temporary project, fixture and local credentials absent. Cloudflare's
post-fix full repeat also passed in `xp3-6076305e3d84`, including explicit overflow
and partial rejection, previous-body retention and the pre-subscribed observer's
cross-window Stop. The hardened Supabase repeat passed in
`xpanel-three-11a0a0104686` with the same coverage, including explicit overflow
and partial failures and prior-success preservation. All three successful
environments were deleted and checked absent, including local credentials.

The hardened 23-file MV3 runtime inventory SHA-256 is
`382d7795c51ab07841452d44ec2a139450fdd4818b95bb2e6f108782acc69eee`.
It hashes sorted `[relativePath, byteLength, sha256]` JSON entries. All three
passes used these exact bytes. Removing the legacy Relay implementation/build
jobs and rebuilding did not change any of these runtime files. The post-removal
Chromium upgrade test also passed again. This is an unpacked runtime digest,
not a final main ZIP digest or permission to publish.

## Historical attempts and cleanup follow-ups

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
- Subsequent full repeats covered upload/multipart/timeout. The old template,
  unused executor helpers and build jobs have now been retired; Git preserves
  their history and the read-only legacy profile migration remains supported.

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
  receipt is unchanged. The maintainer subsequently deleted the local credential
  directory, and a read-only absence check passed on 23 September.
  Readiness now requires three consecutive successful public-route probes,
  including a regression test for intermittent provider responses.
- `xp3-94b9348ffc1c`: passed setup, payload/status/timing and 20 MiB cases;
  the new prior-body assertion incorrectly used response source to decide
  whether diagnostics were displayed. A signed target can have failed body
  integrity. The assertion now uses the explicit diagnostic toggle and waits
  for the previous verified body. Cloud resources and local credentials were
  deleted and absence verified; the original run is not marked as passed.
- `xp3-a5e4bef46fc9`: a streamed oversized response ended early while its final
  report was unavailable. The UI correctly said body integrity was unverified,
  but still promoted that body to the latest success. The extension now keeps
  unverified bodies as diagnostics, and report lookup uses six bounded attempts
  with abortable backoff instead of three near-immediate attempts. Regression
  tests cover delayed partial reports, unavailable reports, cancellation during
  backoff and persisted success classification. All temporary resources and
  credentials were deleted and absence verified. All adapters subsequently
  passed on the hardened runtime; this attempt remains failed.
- `xp3-6076305e3d84`: the full hardened Cloudflare run passed; guarded cleanup
  verified both Workers, D1, synthetic fixture and local credentials absent.
- `xpanel-three-76dde0aa7e45`: the Supabase repeat stopped before UI acceptance
  because the independent synthetic truncation probe did not receive the
  expected wire length. The temporary project, fixture and credentials were
  removed and checked absent. Fixture probes now retry only read-only 404/5xx
  responses, never a successful but non-truncated response, and expose only the
  status code when the advertised length is wrong. This attempt did not pass.
- `xpanel-three-11a0a0104686`: full hardened Supabase UI passed, including
  closed-workbench completion, final digest and pre-subscribed cross-window
  Stop. Cleanup verified the temporary project, fixture and credentials absent.

Failed runs and their cleanup follow-ups are not evidence of passed acceptance.

## Review package and remaining approvals

- Review build at `4b76a59494f6d080e0d4ed3fd6cb30633195b7a5`:
  `xpanelextension-3.0.0-chrome.zip`, 352,246 bytes, 23 entries.
  SHA-256: `01316d6adb5dedefd95949a0ba8d4bac189ee90028b06ba1363ce57b45dfbf1a`.
  Every ZIP entry matches the accepted runtime above; no duplicate or excluded
  private-key/environment paths. This is not the final main Store package.
- Production CycloneDX SBOM: 76 components, including all three official
  one-fetch 0.1.2 distributions and SHA-512 integrity; commit/lockfile-bound.
  Production dependency audit has zero known vulnerabilities.
- Full local `pnpm check` and branch CI passed after retirement. No changed
  implementation/test file exceeds the 1,000-line hard limit.
- The maintainer deleted the older failed attempt's local directory
  `xpanel-one-fetch-cloudflare-4eaOsH`; a read-only check on 23 September confirmed
  it absent. Its cloud resources were already verified absent. No known temporary
  acceptance credentials remain.
- The maintainer explicitly approved a non-squash PR merge and final main
  ZIP/SBOM generation after CI and cleanup verification. Store upload, submission
  and publication are excluded from this authorization. Rebuild on main, then
  obtain separate Store upload/submission confirmation with deferred publishing.

At this pre-merge checkpoint, no media-center restore, retained public Gateway,
xPanel merge or Store submission was performed. Final main artifacts and
separate Store approval remain release gates, not implied by technical checks.
