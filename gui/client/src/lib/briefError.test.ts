// A failed Team Brain sync toasted the entire `execFile` command line — absolute node path,
// script path, every selected file, the `--repo` path — with the one useful sentence last, so the
// toast was ~10 unreadable lines while the readable output pane truncated (audit S5-9).

import { describe, it, expect } from "vitest";
import { briefError } from "./briefError";

describe("briefError", () => {
  it("keeps only the cause from a full execFile dump", () => {
    const raw =
      "Command failed: /Users/x/.nvm/versions/node/v22.21.1/bin/node " +
      "/Users/x/Projects/aios/aios-workspace/scripts/aios.mjs push " +
      "0-context/index.md 2-work/index.md --repo /tmp/ws " +
      "error: aios.yaml has no brain_url (offline/standalone mode). Set brain_url or AIOS_BRAIN_URL.";
    expect(briefError(raw)).toBe(
      "aios.yaml has no brain_url (offline/standalone mode). Set brain_url or AIOS_BRAIN_URL."
    );
  });

  it("takes the LAST error: marker, so a path containing the word survives", () => {
    expect(briefError("run /tmp/error:notes/x.mjs\nerror: the real cause")).toBe("the real cause");
  });

  it("returns a plain message unchanged", () => {
    expect(briefError("network unreachable")).toBe("network unreachable");
  });

  it("skips blank lines after the marker", () => {
    expect(briefError("error:\n\n   the cause\nmore detail")).toBe("the cause");
  });

  it("clips a pathological one-liner", () => {
    const out = briefError(`error: ${"x".repeat(500)}`);
    expect(out).toHaveLength(200);
    expect(out.endsWith("…")).toBe(true);
  });
});
