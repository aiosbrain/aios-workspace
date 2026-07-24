import { afterEach, describe, expect, it, vi } from "vitest";
import { connectErrorMessage, resolveGuiToken } from "./token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function storage(initial = new Map<string, string>()) {
  return {
    getItem: vi.fn((key: string) => initial.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => initial.set(key, value)),
  };
}

describe("resolveGuiToken", () => {
  it("prefers and stores a URL token", () => {
    const sessionStorage = storage();
    vi.stubGlobal("window", { location: { search: "?token=new%20token" } });
    vi.stubGlobal("sessionStorage", sessionStorage);

    expect(resolveGuiToken()).toBe("new token");
    expect(sessionStorage.setItem).toHaveBeenCalledWith("aios.gui.token", "new token");
  });

  it("reuses the session token when the URL is clean", () => {
    const sessionStorage = storage(new Map([["aios.gui.token", "remembered"]]));
    vi.stubGlobal("window", { location: { search: "" } });
    vi.stubGlobal("sessionStorage", sessionStorage);
    expect(resolveGuiToken()).toBe("remembered");
  });

  it("fails closed when browser storage is unavailable", () => {
    vi.stubGlobal("window", { location: { search: "" } });
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(resolveGuiToken()).toBe("");
  });
});

describe("connectErrorMessage", () => {
  it("distinguishes a missing token from a stale connection", () => {
    expect(connectErrorMessage("closed", "")).toMatch(/Missing session token/);
    expect(connectErrorMessage("closed", "present")).toMatch(/closed.*restarted the GUI/);
  });
});
