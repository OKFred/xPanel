# xPanel 2.0

xPanel is a local-first API client embedded in Chrome DevTools. Version 2.0 is
a Manifest V3 rewrite with request collections, safe import/export, response
inspection, and an optional native companion for requests that browser Fetch
cannot faithfully express.

## Highlights

- Runs in the **xPanel** DevTools tab; no account or hosted backend.
- Browser and native execution modes with explicit permission prompts.
- Imports and exports cURL (Bash), PowerShell, Node.js fetch, HAR 1.2,
  OpenAPI 3.x, Swagger 2.0, and the lossless xPanel collection format.
- Favorites, collections, JSON formatting, and one-click copy actions.
- English and Simplified Chinese interface.
- The optional native host never evaluates pasted scripts. It validates a
  structured request and starts cURL without a shell.

## Workspace

```text
apps/extension       WXT + Vue 3 + shadcn-vue/Tailwind MV3 extension
apps/native-host     Cross-platform Native Messaging host
packages/contracts   Runtime-validated shared protocol
packages/request-core Safe request format converters
legacy/              Archived xPanel 1.1.1 MV2 source (not built)
```

## Development

Requirements: Node.js 24, pnpm 11, Chrome 120+, and cURL for native-host tests.

```bash
pnpm install
pnpm --filter @xpanel/extension dev
pnpm check
```

Load `apps/extension/.output/chrome-mv3-dev` from `chrome://extensions`, open
DevTools, then select the xPanel tab. Native host installation is documented in
[docs/native-host.md](docs/native-host.md).

## Privacy and distribution

xPanel has no telemetry and no remote service. Requests go only to destinations
chosen by the user. See [Privacy](docs/privacy.md),
[Permissions](docs/permissions.md), and the [2.0 migration notes](docs/migration-2.0.md).

The current development branch does not publish a GitHub Release or submit a
Chrome Web Store update automatically.

## License

MIT
