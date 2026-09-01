# Migrating from xPanel 1.1.1 to 2.0.0

xPanel 2.0 replaces the Manifest V2 extension with a Manifest V3 DevTools API
client. The existing Chrome Web Store identity remains
`diaemdialoooebdennhpgnmobnjabohm`.

## Breaking change

The old global localhost CORS response-header modification has been removed.
Manifest V3 no longer permits the previous `webRequestBlocking` implementation
for ordinary store extensions. Requests sent from xPanel use exact optional
host access, or the optional native host.

## Upgrade behavior

- Existing users retain the xPanel DevTools entry point.
- Native Messaging and host access are optional and requested only when used.
- The old version did not persist request collections, so no legacy collection
  migration is required.
- The native companion is installed separately and is not bundled inside the
  Chrome Web Store ZIP.

The archived 1.1.1 source remains under `legacy/xpanel-mv2-1.1.1` for reference
and is excluded from every new build.
