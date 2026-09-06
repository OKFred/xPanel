# Permission rationale

| Permission                  | Mode                 | Reason                                                                                                                                     |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                   | Required             | Saves preferences, collections, favorites, and Relay profile metadata locally.                                                             |
| `offscreen`                 | Required             | Creates a temporary extension document using `WORKERS` and `BLOBS` to run packaged workers and process streamed request or response blobs. |
| `alarms`                    | Required             | Schedules cleanup of expired terminal execution records and results; alarms do not initiate network requests.                              |
| `http://*/*`, `https://*/*` | Optional host access | Defaults to exact-origin grants. The user may explicitly grant both wildcard ranges once to avoid prompts when switching API domains.      |

xPanel 2.1.0 does not request `webRequest`, `webRequestBlocking`,
`declarativeNetRequest`, `nativeMessaging`, `cookies`, `tabs`, `downloads`, or
broad required host access. Clipboard writes and file downloads occur only from
direct user actions using web platform APIs.

The service worker and offscreen document operate only inside the extension.
They coordinate Browser or explicitly selected Remote executions and place
temporary results in extension-local IndexedDB independently of a visible
workbench's lifetime. The offscreen document does not read unrelated page or
tab content, capture audio, or provide a hidden browsing surface. Closing the
standalone workbench or DevTools panel does not turn a user-started request into
a scheduled or autonomous request.

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
