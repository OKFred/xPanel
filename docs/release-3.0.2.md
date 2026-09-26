# xPanel 3.0.2 import, Browser headers and sidebar fixes

- HAR response sizes reflect the actual captured UTF-8 or decoded binary bytes,
  not an unrelated declared size. Missing/invalid bodies retain response metadata
  with explicit warnings; local body-integrity checks remain enforced.
- Partial response-import failures explain that requests were already saved,
  avoiding a misleading success message or accidental duplicate imports.
- Opt-in Browser header filtering now handles captured HTTP/2 pseudo-headers.
  Other invalid names/values are rejected before permissions or network access,
  with localized editor-row guidance and no credential values in the error.
  Original and saved requests are never changed by filtering.
- Collections and favorites scroll independently within the sidebar. New-request
  and footer controls remain visible even in a short workbench window.
- No new permissions, storage migration, remote protocol or dependency changes.
  one-fetch client/core/protocol remain pinned to the 0.1.2 Release artifacts.

Regression coverage includes mixed 14-request HAR imports and actual IndexedDB
body reads, a real Chromium header replay, and a long sidebar with 80 requests,
10 collections and 20 favorites in DevTools and an 820x360 standalone window.
Upgrade coverage uses immutable 2.1.0, 3.0.0 and 3.0.1 build baselines.

Branch packages are review candidates, not final Store packages. After an
authorized merge, rebuild from clean, pushed main with `pnpm release:prepare`.
Previous Store packages remain immutable. Upload, review submission and public
publication are separate actions; this preparation does not perform them.
