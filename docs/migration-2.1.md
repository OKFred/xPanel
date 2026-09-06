# Migrating from xPanel 2.0.0 to 2.1.0

xPanel 2.1.0 keeps the Manifest V3 request, collection, import/export, Browser
Fetch, and optional self-hosted Relay behavior from 2.0. It adds a standalone
workbench and moves user-started execution behind a service-worker protocol so
work is no longer owned by one visible UI page.

## Workbench surfaces

- The standalone extension page provides request editing, collections,
  file/text imports, exports, Browser execution, and explicitly selected Remote
  Relay execution without requiring DevTools to stay open.
- The **xPanel** DevTools tab remains available and can additionally import the
  inspected tab's current Network HAR.
- Both surfaces subscribe to the same extension-local execution state and can
  reopen an active or recently completed result.

## Background execution and local retention

Requests still run only after an explicit user action. A service worker
coordinates each run, and a temporary offscreen extension document can finish
the active request after the standalone workbench or DevTools panel closes.
Request payloads, selected files, progress, and response bodies are staged only
in extension-local storage. Inputs are removed after the run; results expire
after ten minutes by default and can be cleared sooner.

An extension alarm removes expired results, including when no workbench is
open. It never starts a request. If Chrome ends the execution context
unexpectedly, xPanel marks an unfinished run as interrupted rather than
silently replaying it.

## Permission changes

- `offscreen` is required only for the temporary extension document that
  continues a user-started request outside a visible workbench.
- `alarms` is required only for expiry cleanup of extension-local execution
  data.
- `storage` remains required for local preferences, collections, favorites, and
  Relay profile metadata.
- HTTP and HTTPS host access remains optional. The default remains an
  exact-origin request, with an explicit all-sites grant available to the user.

The update does not add `webRequest`, `webRequestBlocking`,
`declarativeNetRequest`, `nativeMessaging`, `cookies`, `tabs`, or broad required
host access. Existing requests and collections remain in extension-local
storage while the new execution stores are added.
