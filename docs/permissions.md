# Permission rationale

| Permission                  | Mode                 | Reason                                                                                                                   |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `storage`                   | Required             | Saves preferences, collections, and favorites locally.                                                                   |
| `http://*/*`, `https://*/*` | Optional host access | Grants only the selected request origin when the Browser executor sends a request or resolves an external API reference. |

xPanel 2.0 does not request `webRequest`, `webRequestBlocking`,
`declarativeNetRequest`, `nativeMessaging`, `cookies`, `tabs`, `downloads`, or
broad required host access. Clipboard writes and file downloads occur only from
direct user actions using web platform APIs.
