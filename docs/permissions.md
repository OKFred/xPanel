# Permission rationale

| Permission                  | Mode                 | Reason                                                                                                                   |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `storage`                   | Required             | Saves preferences, collections, and favorites locally.                                                                   |
| `http://*/*`, `https://*/*` | Optional host access | Grants only the selected request origin when the Browser executor sends a request or resolves an external API reference. |

xPanel 2.0 does not request `webRequest`, `webRequestBlocking`,
`declarativeNetRequest`, `nativeMessaging`, `cookies`, `tabs`, `downloads`, or
broad required host access. Clipboard writes and file downloads occur only from
direct user actions using web platform APIs.

Remote Relay uses ordinary HTTPS Fetch to a user-configured endpoint, so it
does not add `cookies`, `nativeMessaging`, or any other required extension
permission. If that endpoint is not already covered, xPanel requests optional
host access for its exact origin. Browser host permission and Relay profile
selection are independent; xPanel never silently changes executors.
