import { describe, it, expect } from "vitest";
import { fmtAge } from "./format";

describe("fmtAge", () => {
  it("renders sub-minute ages in seconds", () => {
    expect(fmtAge(0)).toBe("0s");
    expect(fmtAge(12_400)).toBe("12s");
    expect(fmtAge(59_400)).toBe("59s");
  });

  it("renders minute and hour ages compactly", () => {
    expect(fmtAge(60_000)).toBe("1m");
    expect(fmtAge(5 * 60_000 + 30_000)).toBe("5m");
    expect(fmtAge(2 * 3_600_000 + 60_000)).toBe("2h");
  });

  it("clamps garbage to zero", () => {
    expect(fmtAge(-500)).toBe("0s");
    expect(fmtAge(NaN)).toBe("0s");
  });
});
