# xPanel 2.0

xPanel is a local-first API client embedded in Chrome DevTools. Version 2.0 is
a Manifest V3 rewrite with request collections, safe import/export, response
inspection, and Browser Fetch execution.

## Highlights

- Runs in the **xPanel** DevTools tab; no account or hosted backend.
- Browser Fetch execution with exact-origin permission prompts.
- Per-request timeout control with a 60-second default.
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
```

Load `apps/extension/.output/chrome-mv3-dev` from `chrome://extensions`, open
DevTools, then select the xPanel tab.

## Privacy and distribution

xPanel has no telemetry and no remote service. Requests go only to destinations
chosen by the user. See [Privacy](docs/privacy.md),
[Permissions](docs/permissions.md), and the [2.0 migration notes](docs/migration-2.0.md).

The current development branch does not publish a GitHub Release or submit a
Chrome Web Store update automatically.

## License

MIT
