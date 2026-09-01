# xPanel native host

`com.okfred.xpanel` is the optional native companion for requests that a Manifest V3
extension cannot faithfully replay. It accepts only versioned, Zod-validated structured
messages from `@xpanel/contracts`. Imported Bash, PowerShell, and JavaScript are never
executed. Requests are translated into an allowlisted system-curl argument vector and
spawned with `shell: false`.

## Build and diagnose

Run these commands from the workspace root after `pnpm install`:

```text
pnpm --filter @xpanel/contracts build
pnpm --filter @xpanel/native-host typecheck
pnpm --filter @xpanel/native-host test
pnpm --filter @xpanel/native-host build
pnpm --filter @xpanel/native-host build:bundle
pnpm --filter @xpanel/native-host build:sea
pnpm --filter @xpanel/native-host diagnose
```

`build:sea` creates the current platform/architecture executable under
`dist/sea/<node-platform>-<node-arch>/` together with a `SHA256SUMS` file for the final,
post-injection executable. CI must run the command separately on Windows, macOS, and Linux;
SEA is not cross-compiled. The Node 24 binary and preparation blob are kept on the same
runtime version, with snapshots and code cache disabled.

## Transfer protocol

Native Messaging frames use a four-byte little-endian JSON length prefix and are capped
at 1 MiB. File and response chunks contain at most 512 KiB of decoded bytes.

Upload flow:

1. Extension sends `execute` with `request` and all required `files` descriptors.
2. Host validates file id/purpose/size/SHA-256 and replies with `ack.phase = ready`.
3. Extension sends sequential `chunk` messages and waits for the matching
   `ack.phase = chunk` after every chunk.
4. `chunk.data` is base64 for that chunk's raw bytes. Sequence starts at zero. The last
   chunk has `eof = true` and the full-file SHA-256.
5. Execution begins only after every declared transfer is complete and verified.

An upload that remains idle for five minutes is failed with `UPLOAD_TIMEOUT` and its
request-scoped staging directory is removed. Cancellation and Native Messaging input close
also terminate active curl processes and clean their staging directories.

Large-response flow uses the same `chunk` envelope in the other direction. The extension
must decode every chunk independently, append the raw bytes in sequence order, verify the
full-body SHA-256 from the final chunk, and ACK each chunk. The host waits up to 30 seconds
for each ACK. `complete.response.body` then carries the transfer id, encoding, size, media
type, and hash rather than duplicating the content.

File references never authorize a local path. Body files, multipart files, CA bundles,
client certificates, and private keys must all arrive through a purpose-bound transfer;
`pathHint` is display-only and is never read.

Inline text, JSON, URL-encoded data, and multipart text are limited to 512 KiB. Larger
payloads must be serialized by the extension into a `body.kind = file` execution clone,
declared with `files[].purpose = body`, and uploaded using the same bounded chunk flow.
The original editable request can remain structured in extension storage. The full encoded
Native Messaging frame is still subject to the 1 MiB platform limit.

Redirects are never delegated to curl's `--location`. The host performs at most 20 manual
hops. Same-origin redirects retain scoped headers and authentication, except that a query
API key is not appended again. Cross-origin redirects remove every user header, structured
authentication, cookies, and the TLS client certificate/private key. A cross-origin redirect
that would preserve and replay a request body (including 307/308) is blocked. The CA trust
configuration and TLS verification preference may remain in effect.

## Install

The production manifest allows only
`chrome-extension://diaemdialoooebdennhpgnmobnjabohm/`.

- Windows: `install/install-windows.ps1 [-HostExecutable <exe>] [-ExtensionId <id>]`
- macOS/Linux: `sh install/install-unix.sh [host-binary] [extension-id]`

Passing an extension id is the explicit development-install path. The uninstall scripts
first verify a directly resolved curl 7.70.0 or newer, then register the host. They remove
only the named host registration and files inside the user-level xPanel native-host directory.
