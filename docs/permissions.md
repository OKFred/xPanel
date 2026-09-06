# Permission rationale

| Permission                  | Mode                 | Reason                                                                                                                                |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                   | Required             | Saves preferences, collections, and favorites locally.                                                                                |
| `http://*/*`, `https://*/*` | Optional host access | Defaults to exact-origin grants. The user may explicitly grant both wildcard ranges once to avoid prompts when switching API domains. |

xPanel 2.0 does not request `webRequest`, `webRequestBlocking`,
`declarativeNetRequest`, `nativeMessaging`, `cookies`, `tabs`, `downloads`, or
broad required host access. Clipboard writes and file downloads occur only from
direct user actions using web platform APIs.

The request Options tab shows the current Browser site-access mode. By default,
xPanel requests only the exact origin being used. A user may click **Allow all
sites once** to grant the already-declared optional HTTP and HTTPS wildcard
ranges in one Chrome prompt. Chrome persists that optional grant until the user
revokes or restricts it. **Clear access and ask per domain** removes all granted
HTTP/HTTPS origins and restores the least-privilege behavior.

Remote Relay uses ordinary HTTPS Fetch to a user-configured endpoint, so it
does not add `cookies`, `nativeMessaging`, or any other required extension
permission. If that endpoint is not already covered, xPanel requests optional
host access for its exact origin. Browser host permission and Relay profile
selection are independent; xPanel never silently changes executors.
