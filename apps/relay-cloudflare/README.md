# xPanel Cloudflare Remote Relay

This optional, self-hosted Worker implements xPanel Relay V1. Browser remains
xPanel's default executor. xPanel sends a request here only after the user
selects a named Relay profile and confirms the session disclosure.

The template has no KV, D1, R2, Cache API, analytics, or application logs. It
cannot hide traffic from the Cloudflare account owner or Cloudflare itself, so
deploy it only in an account you trust. xPanel does not operate a public relay.
The Relay is not an anonymity proxy: Cloudflare, the operator, and the target
may observe network metadata including the originating client IP.

## Security defaults

- `TARGET_POLICY` defaults to `allowlist` and
  `ALLOWED_TARGET_ORIGINS` defaults to empty, so a fresh deployment cannot
  contact any target.
- Targets must use credential-free HTTPS URLs. IP literals, localhost, private
  or reserved hostnames, and the Relay itself are denied.
- The request origin is always treated as the Relay itself. If the same Worker
  also has custom domains or other public aliases, list every exact HTTPS
  origin in `RELAY_SELF_ORIGINS`; those aliases are rejected on the initial
  request and on every redirect as well.
- `global_fetch_strictly_public` keeps outbound fetches on the public route,
  including calls to Cloudflare-proxied APIs, instead of bypassing their Worker
  routes or front-door security settings.
- `public-https` is an explicit operator choice. It permits public HTTPS on the
  default port; a non-default port still needs an exact allowlist entry.
- The Worker secret is a lowercase SHA-256 digest. The plaintext bearer token
  is sent only over TLS and compared in constant time.
- Request/response bodies are capped at 20 MiB and decoded metadata at 48 KiB.
- `Host`, `Content-Length`, hop-by-hop/framing, `Proxy-*`, Cloudflare, xPanel
  transport, and request-side `Set-Cookie` headers are rejected. Headers are
  never silently removed from the initial request.
- Target fetches do not set the Workers `cache: no-store` option because that
  option injects `Pragma` and `Cache-Control` fields into the target request.
  Instead, Cloudflare cache TTL is disabled through request metadata, which
  does not alter application Header fields. Users can still send those fields
  explicitly when desired.

## Local setup

Requirements: Node.js 24 and pnpm 11.

```bash
pnpm install
pnpm --filter @xpanel/relay-cloudflare generate:token
```

The command prints only `RELAY_TOKEN_SHA256=<digest>` and tries to place the
plaintext bearer token in the system clipboard. It never prints or writes the
plaintext token. Put the digest in an ignored `.dev.vars` file:

```dotenv
RELAY_TOKEN_SHA256=replace-with-the-generated-64-character-digest
```

Set one or more exact HTTPS target origins in `wrangler.jsonc` while testing,
then run:

```bash
pnpm --filter @xpanel/relay-cloudflare dev
pnpm --filter @xpanel/relay-cloudflare test
```

## Deploy your own Relay

First choose the target policy in `wrangler.jsonc`. Keep `allowlist` for the
smallest attack surface:

```json
{
  "vars": {
    "TARGET_POLICY": "allowlist",
    "ALLOWED_TARGET_ORIGINS": "https://api.example.com https://other.example.org:8443",
    "RELAY_SELF_ORIGINS": "https://relay.example.com"
  }
}
```

Store the generated digest as a Worker secret, then deploy. Do not paste the
plaintext token into Wrangler—the Worker stores only its digest.

```bash
pnpm --filter @xpanel/relay-cloudflare exec wrangler secret put RELAY_TOKEN_SHA256
pnpm --filter @xpanel/relay-cloudflare exec wrangler deploy
```

In xPanel, add the resulting `https://<worker>.<subdomain>.workers.dev` URL and
the plaintext token from the clipboard. Token storage is session-only by
default; choosing local plaintext storage requires a separate risk
confirmation.

## Relay V1 wire format

Both routes require `Authorization: Bearer <token>` and
`X-XPanel-Protocol: 1`.

- `GET /v1/capabilities` returns validated JSON describing limits and
  capabilities.
- `POST /v1/execute` uses outer `Content-Type: application/octet-stream`.
  Strict request metadata is base64url JSON in `X-XPanel-Request`; the outer
  body is the raw target body.
- A successfully executed target response always uses outer status `200`, even
  when the target returned 4xx/5xx. Strict response metadata is in
  `X-XPanel-Response`; the outer body is the raw target response body.
- Relay failures use a non-2xx outer status and a versioned JSON error envelope.

Cloudflare exposes repeated `Set-Cookie` values separately, and the Relay keeps
those values separate in response metadata. The Workers `Headers` runtime can
merge other repeated response fields, so ordinary duplicate fields may be
reported as one combined value.

Responses with a declared size above 20 MiB fail with a structured
`response_too_large` error before response headers are sent. If an upstream
response omits its length, the Relay streams at most 20 MiB and then terminates
the body stream at the hard limit; HTTP status cannot be changed after the
streaming response has started.

The Worker manually handles at most 20 redirects. Every target is revalidated.
All user-supplied headers are removed on a cross-origin redirect. A body is not
replayed across origins; the 3xx is returned with a warning for explicit user
review. Repeated upstream `Set-Cookie` fields are placed separately in response
metadata for display/copy only and are never installed in Chrome.

## Review commands

```bash
pnpm --filter @xpanel/relay-cloudflare typecheck
pnpm --filter @xpanel/relay-cloudflare types:check
pnpm --filter @xpanel/relay-cloudflare test
pnpm --filter @xpanel/relay-cloudflare build
```

`build` is a Wrangler dry run and does not deploy. Deployment is intentionally
separate from repository CI.

Maintainers can run the destructive, environment-gated online suite against a
temporary synthetic Fixture Worker with `pnpm --filter
@xpanel/relay-cloudflare test:online`. It requires
`XPANEL_REMOTE_BASE_URL`, `XPANEL_REMOTE_TARGET_URL`, and
`XPANEL_REMOTE_TOKEN`; the token is never printed. Use the Fixture origin for
this protocol suite. The separate Chromium E2E runner sends directly to the
configured target, so set its `XPANEL_REMOTE_TARGET_URL` to the Fixture's
concrete `/e2e` URL.

For the complete guarded lifecycle, use `test:online:lifecycle`. It refuses CI,
requires a clean Git workspace, accepts only a workers.dev Relay whose name
contains `dev`, `staging`, or `test`, and verifies that the active Relay starts
with an empty allowlist. It creates a cryptographically random Fixture, runs
both protocol and Chromium acceptance with the correct target URLs, restores
the exact prior self-origin aliases with an empty allowlist, and confirms the
Fixture is gone through both Wrangler and HTTP. Cleanup steps are attempted
independently even when acceptance fails.

Provide the token through the process environment, never a command argument or
file. On PowerShell, the maintained `xpanel-relay-dev` flow is:

```powershell
$env:XPANEL_ONLINE_ACCEPTANCE = "I_UNDERSTAND_THIS_DEPLOYS_AND_DELETES_WORKERS"
$env:XPANEL_REMOTE_RELAY_NAME = "xpanel-relay-dev"
$env:XPANEL_REMOTE_BASE_URL = "https://xpanel-relay-dev.example.workers.dev"
$env:XPANEL_REMOTE_TOKEN = Get-Clipboard -Raw
try {
  pnpm --filter @xpanel/relay-cloudflare test:online:lifecycle
} finally {
  Remove-Item Env:XPANEL_ONLINE_ACCEPTANCE -ErrorAction SilentlyContinue
  Remove-Item Env:XPANEL_REMOTE_RELAY_NAME -ErrorAction SilentlyContinue
  Remove-Item Env:XPANEL_REMOTE_BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:XPANEL_REMOTE_TOKEN -ErrorAction SilentlyContinue
}
```

Replace the example workers.dev subdomain with the selected account's actual
subdomain. The lifecycle runner never prints the token and does not run from
GitHub Actions.
