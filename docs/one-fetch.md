# one-fetch integration

xPanel 3 uses the official client, protocol and core **0.1.2** Release tarballs,
with exact URLs, SHA-512 lockfile integrity and an explicit dependency-source
allowlist. These libraries are bundled locally, never downloaded at runtime.
No npm publication or copied protocol implementation is required.

## Configure

Deploy one-fetch using its [Preview release](https://github.com/OKFred/one-fetch/releases/tag/v0.1.2)
and create an HTTP execution token in its administration UI. Add a named profile
with the Control URL, Gateway URL and token. Supabase URLs may share an origin
but have separate `/functions/v1/one-fetch-control` and `one-fetch-gateway`
prefixes. HTTPS is required except explicitly approved local loopback HTTP.

Connection testing only verifies public capabilities. It does **not** prove that
the execution token is valid or send a probe to an arbitrary target. Token and
Gateway validation happen when you explicitly send. Browser remains the default
after Chrome restarts. Local plaintext token retention needs extra confirmation.

User deny rules use the official schema and only further restrict access. An
empty administrator allowlist denies all requests; user rules cannot override it.
Changes to profile endpoints, token, instance or service configuration invalidate
session trust. Account management remains outside the extension.

## What a result proves

- A target badge means the response metadata signature, nonce and request ID
  matched. A target 4xx/5xx is still a target response.
- A one-fetch error displays its code and stage. A missing/invalid signature or
  identity mismatch is an intermediary response, not automatically a CF fault.
- Body integrity is separate. A complete final report and matching SHA-256 are
  required for “Verified”. Missing reports or digests remain “Not verified”.
  Partial, failed or mismatched results cannot overwrite the last success.
- The explicitly negotiated browser envelope uses outer HTTP 200 while keeping
  the true target status signed. This preserves manual 3xx results in Chromium.
  Older services without `envelope-v1` support are blocked with an upgrade hint.
- All three 0.1.2 adapters can supply a body digest. A clean EOF or outer 200 alone
  is insufficient: an oversized/partial final report still fails verification.
  No immutable release has been overwritten.
- Final report queries retry at most three times, with five seconds per attempt,
  inside the request's overall timeout and cancellation deadline.

Target Headers and outer service Headers are separate. Multiple Set-Cookie
values remain separate entries and are never installed in Chrome. Remote sends
only explicit Cookie headers. Provider-added/modified/merged headers are disclosed;
the service cannot guarantee raw-socket equivalence. Unsupported options fail
before transmission instead of being silently removed.

DNS/TCP/TLS/TTFB/download phases absent from a service report are unavailable,
not zero. Target Server-Timing is separate from Gateway and extension timing.
The protocol does not expose a full portable redirect chain; xPanel does not
invent one. Explicit file selection is required; imported paths are never read.

This release supports HTTP only: no Native, plugin login, proxy configuration,
custom TLS editor, WebSocket, TCP or TLS tunnel. No public xPanel proxy exists.
