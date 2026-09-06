# xPanel Privacy Policy

Effective date: 2026-09-06

xPanel processes request data only to provide the API-client features that the
user explicitly invokes. xPanel does not transmit request data to the developer
and does not sell or analyze user data. It has no analytics, advertising,
account system, xPanel-operated backend, or telemetry.

## Data handled locally

- Request drafts, collections, favorites, preferences, imported API documents,
  and optional saved response examples are stored only in extension-local
  browser storage.
- When the user starts a background request, xPanel temporarily stages that
  request and any selected files in extension-local IndexedDB so execution can
  continue if the visible workbench closes. The staged payload and files are
  removed when execution completes, fails, is cancelled, or is marked
  interrupted. Result metadata and bodies expire after ten minutes by default.
  The user may instead select one hour, the current Chrome session, or manual
  retention; choosing manual retention requires an additional sensitive-data
  warning and the result remains local until the user clears it or removes the
  extension.
- Credentials and sensitive values in headers, query parameters, URL userinfo,
  auth fields, proxy settings, and file metadata are handled only for the
  request the user starts. They are otherwise persisted only when the user
  explicitly chooses to save them.
- Exported files are created only after a user action and are sanitized by
  default.
- Files selected for request bodies are sent only with the request the user
  explicitly starts; temporary background-execution copies follow the same
  local cleanup rules described above.

## Network behavior

xPanel sends Browser traffic only to URLs selected by the user or to external
OpenAPI references the user explicitly agrees to resolve. It does not send a
copy of Browser requests or responses to the developer.

A Manifest V3 service worker coordinates user-started executions. A temporary
offscreen extension document performs each request independently of the visible
workbench's lifetime. It does not inspect unrelated tabs or pages, and it does
not create, schedule, or retry requests without a user action. Chrome alarms
are used only to remove expired local execution data; they do not trigger
network requests. Closing Chrome ends the execution context; an unfinished run
is later marked interrupted and is not replayed automatically.

Remote Relay is optional and self-hosted. A Remote request is sent only through
the named Relay profile the user explicitly selects. Before the first send in a
Chrome session, xPanel shows the target origin, Relay host, and data categories
that will leave the device. The request URL, headers, credentials, files, and
body then pass through that service to the destination. The relay token is kept
in browser session storage by default; local plaintext storage requires a
separate risk confirmation. Relay profiles, tokens, and trust decisions are not
included in requests, collections, or exports.

The bundled Cloudflare template disables application observability and does not
use KV, D1, R2, or Cache. A relay operator still controls their deployment and
Cloudflare account, so users should trust that operator before sending secrets.
Remote Relay is not an anonymity service: Cloudflare, the Relay operator, and
the destination may observe network metadata including the originating client
IP.
Returned `Set-Cookie` values are displayed and can be copied, but are never
written to Chrome's cookie jar.

## User control

- Request data saved in local extension storage remains until the user deletes
  it or removes the extension.
- Temporary execution inputs are removed at the end of the run. Temporary
  results expire after ten minutes by default. The selectable alternatives are
  one hour, the current Chrome session, and retention until manual cleanup. The
  user can clear any retained result sooner; extension alarms perform timed
  expiry cleanup even when no workbench is open.
- Session-only Relay tokens and trust decisions are cleared when the Chrome
  session ends. Locally persisted Relay tokens remain until the user deletes
  the profile or removes the extension.
- Removing the extension deletes its browser-managed local storage.

## Chrome Web Store Limited Use

The use of information received from Chrome APIs will adhere to the Chrome Web
Store User Data Policy, including the Limited Use requirements. xPanel uses
that information only to provide or improve its user-facing API-client
features. It is not used for personalized advertising, creditworthiness or
lending decisions, and it is not sold to third parties. The developer does not
permit humans to read user data except with the user's affirmative consent for
support, when required for security, or when required by law.

Questions can be sent to zq.admin.vip@gmail.com.
