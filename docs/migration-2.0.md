# Migrating from xPanel 1.1.1 to 2.0.0

xPanel 2.0 replaces the Manifest V2 extension with a Manifest V3 DevTools API
client. The existing Chrome Web Store identity remains
`diaemdialoooebdennhpgnmobnjabohm`.

## Breaking change

The old global localhost CORS response-header modification has been removed.
Manifest V3 no longer permits the previous `webRequestBlocking` implementation
for ordinary store extensions. Requests sent from xPanel use Browser Fetch with
exact optional host access.

## Upgrade behavior

- Existing users retain the xPanel DevTools entry point.
- HTTP and HTTPS host access is optional and requested for the selected request
  origin only when sending.
- The old version did not persist request collections, so no legacy collection
  migration is required.
- Proxy selection, custom TLS verification, client certificates, and restricted
  request headers cannot be applied by Browser Fetch. Imports preserve their
  static structure and report the unsupported options instead of silently
  dropping them.

The archived 1.1.1 source remains under `legacy/xpanel-mv2-1.1.1` for reference
and is excluded from every new build.
