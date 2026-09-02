# Migrating from xPanel 1.1.1 to 2.0.0

xPanel 2.0 replaces the Manifest V2 extension with a Manifest V3 DevTools API
client. The existing Chrome Web Store identity remains
`diaemdialoooebdennhpgnmobnjabohm`.

Browser remains the default executor. Version 2.0 also supports explicitly
configured, self-hosted Remote Relay profiles for requests that Browser Fetch
cannot faithfully express. Relay configuration, tokens, and session trust are
not migrated into request or collection data, and the selected executor resets
to Browser when Chrome closes.

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
- The former Native companion design is not part of xPanel 2.0. Remote Relay
  supports application-layer headers, files, multipart bodies, and displayed
  `Set-Cookie` values, but not custom proxy or TLS/client-certificate settings.

The archived 1.1.1 source remains under `legacy/xpanel-mv2-1.1.1` for reference
and is excluded from every new build.
