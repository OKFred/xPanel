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
failure; follow-up verified cloud resource absence, but its separate local
credential directory still requires user deletion. No media-center restore was
performed and no public Gateway is retained.

## Remaining release/integration gates

- The final main CI and CodeQL passed. Review bundle run
  [35733088736](https://github.com/OKFred/one-fetch/actions/runs/35733088736)
  succeeded; downloaded artifacts still require local provenance and packaged
  runtime verification before publication.
- Finish the earlier local credential cleanup and record its absence.
- Publish a new immutable 0.1.2 Preview, then pin xPanel to those exact Release
  URLs and lockfile integrity. Never replace v0.1.1 assets or its tag.
- Run the full xPanel UI/Offscreen/upgrade suite with the new dependency before
  retiring the legacy Relay build. xPanel merge and Store submission remain
  separate approval gates.
