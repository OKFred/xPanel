# xPanel 3.0 integration

This branch replaces the legacy Relay V1 client with one-fetch Protocol V1.
Browser execution and portable request/collection formats remain unchanged.

The client, core and protocol dependencies use immutable `v0.1.2` GitHub
Release archives, with SHA-512 integrity in pnpm-lock.yaml. Never replace a
published archive under the same tag or fall back to an unpinned branch.

Source: `056380ecbfc48cedea82096a86196a29261395b4` in OKFred/one-fetch.
Review bundle: https://github.com/OKFred/one-fetch/actions/runs/35733088736.
Client SHA-256: `1bcd7f1808419116d30e5401abe87b0f925fa0840d84c84b8e5019d8f9c79d15`.
Core SHA-256: `0c6287c34f35ab3855125d4eb92ad904c1061d913b09ff69eb23fc4a0bc5b459`.
Protocol SHA-256: `67425c68d3f5eeb3ceb691ed66fae1884c808a468b203131e13a659241e1d13a`.

xPanel explicitly requires the advertised `adapter.browserResponse` capability
with `envelope-v1`. The signed target status is independent of outer HTTP 200;
old services without this browser-compatible mode are blocked before Gateway
access. Signature/identity/mode mismatches remain intermediary diagnostics.

Profiles use separate Control and Gateway service URLs; same-origin Supabase
function prefixes are supported. HTTPS is required except explicitly confirmed
loopback HTTP. Execution tokens default to Chrome session storage. No account
password, refresh-token flow or administrator policy editing is added here.

Implementation and test results on this branch do not imply hosted extension
acceptance, merge approval, or Chrome Web Store submission. Those are separate
gates. media-center must not be restored for acceptance.
