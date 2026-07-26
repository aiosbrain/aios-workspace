import { describe, expect, it } from "vitest";
import { autoDenyRemaining } from "./PermissionCard";
import type { PendingPermission } from "../../types/messages";

const base: PendingPermission = { id: 1, tool: "Bash", input: {} };

describe("autoDenyRemaining", () => {
  it("returns null when the server sent no deadline", () => {
    expect(autoDenyRemaining(base, 1000)).toBeNull();
    expect(autoDenyRemaining({ ...base, timeoutMs: 300_000 }, 1000)).toBeNull(); // no receivedAt
  });

  it("counts down m:ss from the arrival time", () => {
    const p = { ...base, timeoutMs: 300_000, receivedAt: 0 };
    expect(autoDenyRemaining(p, 0)).toBe("5:00");
    expect(autoDenyRemaining(p, 61_000)).toBe("3:59");
    expect(autoDenyRemaining(p, 299_001)).toBe("0:01");
  });

  it("returns null at and past expiry", () => {
    const p = { ...base, timeoutMs: 300_000, receivedAt: 0 };
    expect(autoDenyRemaining(p, 300_000)).toBeNull();
    expect(autoDenyRemaining(p, 400_000)).toBeNull();
  });
});
