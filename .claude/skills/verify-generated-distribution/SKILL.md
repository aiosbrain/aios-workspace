---
name: verify-generated-distribution
description: Verify source changes that require rebuilt `dist/`, vendored assets, generated catalogs, Tauri resources, manifests, or lock artifacts. Use to identify source-to-generated relationships, rebuild canonically, prove freshness and parity, and test packaged output.
---

# Verify generated distribution

1. Identify every changed source file and its generated, vendored, packaged, manifest, catalog,
   lock, or desktop-resource consumer.
2. Find the canonical generation command from repository tooling; do not reconstruct it ad hoc.
3. Run generation in the pinned environment and capture tool or runtime versions.
4. Verify source and generated semantic parity and a stable second generation. Unexpected diff or
   non-idempotence is a failure.
5. Run tests against the generated or packaged artifact, not only source modules.
6. Check tracked freshness, executable modes, path layout, manifests, checksums, and clean-install
   behavior.
7. Return the source-to-artifact map, commands, diff or freshness result, and packaged verification.

Do not make generated files canonical or rebuild unrelated artifacts.
