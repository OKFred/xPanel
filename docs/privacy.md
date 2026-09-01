# xPanel Privacy Policy

Effective date: 2026-09-02

xPanel does not collect, sell, transmit, or analyze user data. It has no
analytics, advertising, account system, hosted backend, or telemetry.

## Data handled locally

- Request drafts, collections, favorites, preferences, imported API documents,
  and optional response examples are stored only in the extension's local
  browser storage.
- Credentials and sensitive values in headers, query parameters, URL userinfo,
  auth fields, proxy settings, and file metadata are not persisted unless the
  user explicitly chooses to save them.
- Exported files are created only after a user action and are sanitized by
  default.
- The optional native host receives only requests explicitly sent through the
  Native executor. Communication stays on the same device through Chrome
  Native Messaging.

## Network behavior

xPanel sends network traffic only to URLs selected by the user or to external
OpenAPI references the user explicitly agrees to resolve. It does not send a
copy of requests or responses to the developer.

## User control

Removing the extension deletes its browser-managed local storage. The native
host has separate uninstall scripts that remove its executable, registration,
and temporary working files.

Questions can be sent to zq.admin.vip@gmail.com.
