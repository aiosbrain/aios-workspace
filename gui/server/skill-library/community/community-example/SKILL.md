---
name: community-example
description: A demonstration community-tier skill used to exercise the untrusted-install scan + typed-consent gate. It bundles a small helper script (no network, no secrets), so it scans as "elevated" and requires explicit consent before install.
---

# Community example (demonstration)

This is a **community-tier** skill: it is NOT vendored from the official
`anthropics/skills` library and carries no first-party provenance. The cockpit must
statically scan it and require your explicit consent before installing.

It ships one benign helper, `scripts/wordcount.sh`, that counts words in stdin. There
is no network egress, no secret access, and no external URL — so the scan classifies it
as `elevated` (code present, no high-severity signals), which still requires a consent
click. A skill with network/secret/injection signals would classify `high` and require
a typed confirmation.
