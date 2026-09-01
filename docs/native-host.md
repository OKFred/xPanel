# Native host

The optional `com.okfred.xpanel` Native Messaging host provides high-fidelity
HTTP replay without executing imported Bash, PowerShell, or JavaScript.

## Security model

- Every message is validated against the shared versioned protocol.
- cURL is started with an argument array and `shell: false`.
- File references imported from commands remain unresolved until the user
  selects the file again.
- Temporary payload and certificate files are scoped to one request and removed
  on normal completion, cancellation, or Native Messaging input shutdown.
- The production host accepts only the Chrome Web Store origin
  `chrome-extension://diaemdialoooebdennhpgnmobnjabohm/`.

## Installation

Review artifacts contain a platform binary, `SHA256SUMS`, a native host
manifest, an SBOM, and user-level install/uninstall scripts. Development installers require an
explicit extension ID so an unpacked build can be authorized without widening
`allowed_origins`.

The installer verifies that cURL is available before registering the host.
Windows uses HKCU; macOS and Linux use the current user's Chrome
`NativeMessagingHosts` directory. No administrator access is required.
