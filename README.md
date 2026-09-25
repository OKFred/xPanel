# xPanel 3.0.1

xPanel is a local-first API workbench available both as a standalone extension
page and inside Chrome DevTools. Version 3.0.0 replaces the old Remote Relay with
explicitly configured [one-fetch 0.1.2 Preview](https://github.com/OKFred/one-fetch/releases/tag/v0.1.2)
services, while retaining Browser Fetch, background execution, collections,
safe import/export, and the virtual response viewer.

Version 3.0.1 fixes export validation for blank or invalid request URLs, keeps
unfinished requests eligible for collection backup, and prevents failed or stale
export previews from being copied or downloaded. See [patch notes](docs/release-3.0.1.md).

## Highlights

- Runs as a standalone workbench or in the **xPanel** DevTools tab; only the
  DevTools surface can import the current tab's Network HAR.
- Runs a request explicitly started by the user in a temporary extension
  offscreen document so it can continue when either workbench surface closes. Staged
  inputs are removed when the run ends; local results expire after ten minutes
  by default.
- Browser Fetch execution with exact-origin permission prompts by default, plus
  an explicit one-time all-HTTP/HTTPS grant for users who regularly switch API
  domains.
- Named one-fetch profiles with separate Control and Gateway URLs, session-only
  execution tokens by default, and optional per-profile user deny rules.
  Remote sends require only service-site permission, not target-site grants.
  xPanel never switches to Remote silently.
- Distinguishes signed target responses, signed service errors and unverified
  intermediary responses. Target and outer headers, execution timing and target
  Server-Timing are displayed separately; returned cookies are never installed.
- Per-request timeout control with a 60-second default.
- Honest staged progress, streamed response downloads, and one Stop control for
  both Browser and Remote requests.
- Imports and exports cURL (Bash), PowerShell, Node.js fetch, HAR 1.2,
  OpenAPI 3.x, Swagger 2.0, and the lossless xPanel collection format.
- Favorites and collections with confirmed deletion, JSON formatting, and
  one-click copy actions.
- English and Simplified Chinese interface.
- Imported commands are parsed as static text and are never evaluated or
  executed as Bash, PowerShell, or JavaScript.

## Workspace

```text
apps/extension       WXT + Vue 3 + shadcn-vue/Tailwind MV3 extension
packages/contracts   Runtime-validated request and response schemas
packages/request-core Safe request format converters
legacy/              Archived xPanel 1.1.1 MV2 source (not built)
```

## Development

Requirements: Node.js 24, pnpm 11, and Chrome 120+.

```bash
pnpm install
pnpm --filter @xpanel/extension dev
pnpm check
pnpm e2e:chromium
```

The Chromium E2E runner uses an isolated temporary profile and an installed
Chromium/Chrome for Testing binary. Set `XPANEL_CHROMIUM_EXECUTABLE` when it
cannot discover one. `node scripts/e2e-chromium.mjs --one-fetch-node` runs the
published, digest-checked Node archive in an owned disposable Docker container.
Online acceptance is explicitly opt-in via `--one-fetch-cloudflare` or
`--one-fetch-supabase`; it requires a clean sibling one-fetch v0.1.2 checkout,
logged-in CLIs, and permission to create and delete temporary synthetic resources.
It never uses media-center. Receipts under `artifacts/one-fetch-e2e` are sanitized.

Load `apps/extension/.output/chrome-mv3-dev` from `chrome://extensions`. Open
the standalone workbench from the extension action, or open DevTools and select
the xPanel tab.

## Privacy and distribution

xPanel has no telemetry and operates no relay service. Browser requests go
directly to destinations chosen by the user. A Remote request is sent only
after the user explicitly selects and trusts their own relay profile; its URL,
headers, credentials, and body pass through that service. The service operator
controls its audit retention and provider logging. Background execution
does not schedule or invent requests: the service worker and offscreen document
only continue work the user started, and alarms only remove expired local
execution data. See
[one-fetch integration and limitations](docs/one-fetch.md), [Privacy](docs/privacy.md),
[Chrome Web Store submission kit](docs/chrome-web-store/submission.md),
[Permissions](docs/permissions.md), and the [3.0 migration notes](docs/migration-3.0.md).

GitHub Actions does not upload, submit, or publish a Chrome Web Store update.
After the reviewed commit reaches `main` and release checks pass, a maintainer
must upload and submit it with automatic publishing disabled. Approval then
stages the update for a separate manual publish action within 30 days.

## License

MIT
