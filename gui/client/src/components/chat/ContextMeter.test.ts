import { describe, expect, test } from "vitest";
import { estimateContext } from "./context-usage";

describe("estimateContext", () => {
  test("uses the cache-inclusive current prompt", () => {
    expect(
      estimateContext(
        {
          input_tokens: 10_000,
          cache_read_input_tokens: 70_000,
          cache_creation_input_tokens: 20_000,
          output_tokens: 4_000,
        },
        200_000
      )
    ).toEqual({ tokens: 100_000, percent: 50, valid: true });
  });

  test("refuses to present an impossible aggregate as context occupancy", () => {
    expect(estimateContext({ input_tokens: 681_000 }, 200_000)).toEqual({
      tokens: 681_000,
      percent: 0,
      valid: false,
    });
  });

  test("handles absent and malformed usage defensively", () => {
    expect(estimateContext(null, 200_000)).toEqual({ tokens: null, percent: 0, valid: true });
    expect(estimateContext({ input_tokens: Number.NaN, output_tokens: -4 }, 200_000)).toEqual({
      tokens: 0,
      percent: 0,
      valid: true,
    });
  });
});
