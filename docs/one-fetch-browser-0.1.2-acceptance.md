# one-fetch 0.1.2 browser compatibility acceptance

Source under test: `056380ecbfc48cedea82096a86196a29261395b4` in
[one-fetch](https://github.com/OKFred/one-fetch/commit/056380ecbfc48cedea82096a86196a29261395b4).
These are official-client source probes in a real MV3 Chromium page, **not**
xPanel UI acceptance, published tarball acceptance or Store submission evidence.

## Verified on 22 September 2026

All nine cases passed independently against Node 24.20.0, hosted Cloudflare and
hosted Supabase: target 201/302/404/503, redirect, repeated Set-Cookie,
Server-Timing, complete 20 MiB and 20 MiB + 1 overflow. The browser response mode
preserves the signed target status while exposing outer HTTP 200. Complete-body
cases require a matching final report, byte count and SHA-256.

The probes use actual optional host grants, without modifying Fetch/CORS or
disabling browser security. The SDK is built into a test-only bundle from the
exact clean source commit; normal extension dependencies remain Release-only.
Tokens are memory-only and no target header values or response bodies are saved.

An edge provider can surface an oversized response as clean EOF instead of a
reader exception. Overflow must still return an incomplete `partial` report,
`response_too_large`, no complete digest, and at most 20 MiB received. A normal
EOF or outer 200 alone is never proof of complete success. Earlier failed probes
are not relabelled as passes.

## Receipt identity

Receipts are local under `artifacts/one-fetch-e2e`; hashes below are SHA-256.

| Adapter    | Receipt filename                                                            | SHA-256                                                            |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Node       | `browser-node-056380ecbfc4-fe21b05a-786e-4fed-b546-404a727b56c9.json`       | `8fe26c1847592f3eab43c66830ede37b952e7be7ecb179686356f799c37ac578` |
| Supabase   | `browser-supabase-056380ecbfc4-07753778-17b5-475f-95d8-59d74c6612a7.json`   | `f64d10d44f0513ba910535c05af1d962725da9a7f6b55db9e7404487be022b30` |
| Cloudflare | `browser-cloudflare-056380ecbfc4-40b6ea79-4197-4b37-aff4-61609f7ad103.json` | `1a58603d96f0b49192234fb603827aa28e12a225b965f31f9a696607e6c04713` |

Each final run verified removal of its owned temporary runtime and local
credentials. One earlier Cloudflare run had a transient cleanup inventory auth
failure; follow-up verified cloud resource absence. The user removed its separate
local credential directory; a read-only existence check on 22 September confirmed
it is absent. The original failed cleanup receipt was not rewritten. No media-center restore was
performed and no public Gateway is retained.

## Downloaded review artifacts

Review run `35733088736` produced a clean main build of `056380ecbfc4`.
The exact 18-file inventory, manifest, SHA-256/SHA-512 lists and safe archive paths
passed local verification. All 16 provenance subjects passed verification with
the exact repository, `release-review.yml` signer, source commit and main ref;
self-hosted runners were disallowed.

The downloaded Node distributions also passed HTTP/authentication/audit checks:

| Mode                                         | Platform       | Receipt SHA-256                                                    |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| Portable archive                             | AMD64          | `d9b94dd566881ba648c2b6ac0611880cd7dfa0269ba9af538ea7aeba263d96ce` |
| OCI                                          | AMD64          | `c9a4ae09f6698a7b7123a005c3bce63958443718849282ae1e3f9365d47186a4` |
| OCI                                          | Emulated ARM64 | `12f8ec5687beed85f3b22f9ea0933ac78ecb4ed72a8a182227d30ed5f8ff4fad` |
| Installed archive + isolated backup recovery | AMD64          | `9456c8554987f9ae64e04accb3ca5a374047eb88ceb8db2ecc4da0332eeb4218` |

These four new owned containers were removed and their absence verified. Older
unrelated 0.1.0 containers were not modified. This is not a native ARM64 hardware
test or a repeat of every historical cross-version deployment rehearsal.

## Published release verification

The public release contains the same 18 files. Anonymous downloads of all files
passed manifest and SHA-256/SHA-512 checks after publication; the annotated tag
resolves to the exact source commit above. GitHub API metadata required the
already-authenticated CLI account because the shared anonymous API quota returned 403. Artifact downloads themselves were anonymous. The original rate-limited
attempt is retained as incomplete, not relabelled.

Public-download receipt SHA-256:
`2a30b229d74c7b6f230d3218253741620acd9045421a9f6e331e7b8c919c99fb`.
Provenance was verified separately against the unchanged review artifacts; the
public-download verifier does not claim to verify provenance itself.

## xPanel Node UI acceptance after publication

With the published 0.1.2 client/core/protocol and Node archive, actual xPanel
Chromium interaction passed target 201/302/404/503, policy errors, repeated
Set-Cookie, Server-Timing, complete 20 MiB, oversized/partial rejection and Stop
(62.0 ms). Browser, DevTools HAR, 318 KiB virtual viewer, bilingual UI and
standalone recovery also passed. Offscreen finished after all workbenches closed
and the service worker was terminated; Popup recovery, final digest verification
and cross-interface Stop passed. The owned Docker container was removed and its
absence verified. Cloud UI and upgrade acceptance are still separate gates.

## Remaining release/integration gates

- The final main CI and CodeQL passed. Review bundle run
  [35733088736](https://github.com/OKFred/one-fetch/actions/runs/35733088736)
  succeeded; local provenance and packaged runtime verification passed as above.
- Earlier local credential cleanup is complete and absence verified.
- [0.1.2 Preview](https://github.com/OKFred/one-fetch/releases/tag/v0.1.2) was
  published on 22 September from this commit with the 18 unchanged review files.
  xPanel pins the new Release URLs and SHA-512 integrity. v0.1.1 is unchanged.
- The full xPanel UI/Offscreen/upgrade suite and legacy Relay retirement are
  recorded in [the current UI acceptance evidence](one-fetch-3-ui-acceptance.md).
  xPanel merge and Store submission remain separate approval gates.
