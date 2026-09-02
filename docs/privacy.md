# xPanel Privacy Policy

Effective date: 2026-09-03

xPanel processes request data only to provide the API-client features that the
user explicitly invokes. xPanel does not transmit request data to the developer
and does not sell or analyze user data. It has no analytics, advertising,
account system, xPanel-operated backend, or telemetry.

## Data handled locally

- Request drafts, collections, favorites, preferences, imported API documents,
  and optional response examples are stored only in the extension's local
  browser storage.
- Credentials and sensitive values in headers, query parameters, URL userinfo,
  auth fields, proxy settings, and file metadata are not persisted unless the
  user explicitly chooses to save them.
- Exported files are created only after a user action and are sanitized by
  default.
- Files selected for request bodies remain in the extension page's memory and
  are sent only with the request the user explicitly starts.

## Network behavior

xPanel sends Browser traffic only to URLs selected by the user or to external
OpenAPI references the user explicitly agrees to resolve. It does not send a
copy of Browser requests or responses to the developer.

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
