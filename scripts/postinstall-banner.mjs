#!/usr/bin/env node
// postinstall-banner.mjs — `npm install` in this toolkit repo (folder A, see
// docs/GETTING-STARTED.md §1) ends on npm's own audit/funding noise with nothing
// telling a brand-new user "you're done, here's what's next." This prints one
// unmissable line after install finishes. Silent in CI so it doesn't spam build logs.

if (!process.env.CI) {
  console.log("");
  console.log("\x1b[0;32m✓ AIOS toolkit installed.\x1b[0m");
  console.log(
    "  Next: scaffold your real workspace — scripts/scaffold-project.sh --context employee --slug <your-slug> --owner <you>"
  );
  console.log("");
}
