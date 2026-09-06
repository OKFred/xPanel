# xPanel 2.1.0

xPanel is a local-first API workbench available both as a standalone extension
page and inside Chrome DevTools. Version 2.1.0 adds extension-managed background
execution while retaining request collections, safe import/export, response
inspection, Browser Fetch, and the optional self-hosted Remote Relay.

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
- Explicitly selected, named Remote Relay profiles for requests that browser
  Fetch cannot faithfully express. xPanel never switches to a relay silently.
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
apps/relay-cloudflare Self-hosted Cloudflare Worker implementing Relay V1
packages/contracts   Runtime-validated request and response schemas
packages/request-core Safe request format converters
legacy/              Archived xPanel 1.1.1 MV2 source (not built)
```

## Development

Requirements: Node.js 24, pnpm 11, and Chrome 120+.

```bash
pnpm install
pnpm --filter @xpanel/extension dev
pnpm --filter @xpanel/relay-cloudflare dev
pnpm check
pnpm e2e:chromium
```

The Chromium E2E runner uses an isolated temporary profile and an installed
Chromium/Chrome for Testing binary. Set `XPANEL_CHROMIUM_EXECUTABLE` when it
cannot discover one. Optional online Relay acceptance also reads
`XPANEL_REMOTE_BASE_URL`, `XPANEL_REMOTE_TOKEN`, and
`XPANEL_REMOTE_TARGET_URL`; it never prints the token. The protocol suite uses
the synthetic Fixture origin as the target, while Chromium E2E expects the
fixture's concrete `/e2e` URL.

Load `apps/extension/.output/chrome-mv3-dev` from `chrome://extensions`. Open
the standalone workbench from the extension action, or open DevTools and select
the xPanel tab.

## Privacy and distribution

xPanel has no telemetry and operates no relay service. Browser requests go
directly to destinations chosen by the user. A Remote request is sent only
after the user explicitly selects and trusts their own relay profile; its URL,
headers, credentials, and body pass through that service. Background execution
does not schedule or invent requests: the service worker and offscreen document
only continue work the user started, and alarms only remove expired local
execution data. See
[Relay deployment](apps/relay-cloudflare/README.md), [Privacy](docs/privacy.md),
[Chrome Web Store submission kit](docs/chrome-web-store/submission.md),
[Permissions](docs/permissions.md), and the [2.1 migration notes](docs/migration-2.1.md).

GitHub Actions does not upload, submit, or publish a Chrome Web Store update.
After the reviewed commit reaches `main` and release checks pass, a maintainer
must upload and submit it with automatic publishing disabled. Approval then
stages the update for a separate manual publish action within 30 days.

## License

MIT
