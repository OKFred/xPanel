# xPanel 3.0 integration

This branch replaces the legacy Relay V1 client with one-fetch Protocol V1.
Browser execution and portable request/collection formats remain unchanged.

The client, core and protocol dependencies use immutable `v0.1.1` GitHub
Release archives, with SHA-512 integrity in pnpm-lock.yaml. Never replace a
published archive under the same tag or fall back to an unpinned branch.

Source: `b8e8b3558bca6236e92b7c18db167759da9cc43c` in OKFred/one-fetch.
Review bundle: https://github.com/OKFred/one-fetch/actions/runs/35696257932.
Client SHA-256: `09a300fcbd1ea443c7ed6397eda7b68dcdac4c9b03186a43eaa9c131b6d7e442`.
Core SHA-256: `49d0508ad194647230b59571ffb3d16a80a6745263d6e8150b1039ab5df6d011`.
Protocol SHA-256: `ba6122a24fd7472a6cbc9a189de77866a4c3a48a50ff7944299510b12fdbf532`.

Profiles use separate Control and Gateway service URLs; same-origin Supabase
function prefixes are supported. HTTPS is required except explicitly confirmed
loopback HTTP. Execution tokens default to Chrome session storage. No account
password, refresh-token flow or administrator policy editing is added here.

Implementation and test results on this branch do not imply hosted extension
acceptance, merge approval, or Chrome Web Store submission. Those are separate
gates. media-center must not be restored for acceptance.
