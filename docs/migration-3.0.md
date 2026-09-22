# Upgrading 2.1.0 to 3.0.0

Browser requests, favorites, collections, import/export, DevTools and standalone
workbench remain. RequestSpecV1, ResponseRecordV1 and collection files do not
change. Existing results without verification details never become “verified”.

The old Remote Relay executor is replaced by one-fetch Protocol V1. Old profiles
are shown read-only and cannot send; their URLs are not guessed into a new pair,
and their tokens are not reused. Create a new one-fetch profile explicitly, then
use the confirmed deletion action to remove old configuration and credentials.

The extension permission sets remain `storage`, `offscreen`, `alarms` and
optional HTTP/HTTPS host access. Remote needs the two service origins only;
Browser's origin-grant behavior is unchanged. No Cookie permission is added.

Local verification sidecars follow the response retention policy (10 minutes
by default). They are excluded from portable exports and never contain service
tokens. Offscreen executions can outlive a workbench; closing Chrome or updating
the extension cannot resume a live network connection, so unfinished executions
become orphaned and are not automatically replayed.

The old Relay template, executor helpers and build tasks have been retired;
their source remains recoverable from Git history. Collection schemas and the
read-only legacy profile migration are retained.

Before Store submission, complete all three real-adapter Chromium acceptance
checks, merge only after explicit approval and rebuild from final main.
Submission and deferred publishing require
a separate confirmation; development artifacts are not Store releases.
