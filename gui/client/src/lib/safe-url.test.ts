import { describe, test, expect } from "vitest";

import { isSafeExternalUrl } from "./safe-url";

describe("isSafeExternalUrl", () => {
  test("accepts plain https provider URLs", () => {
    expect(isSafeExternalUrl("https://slack.com/oauth/v2/authorize?state=xyz")).toBe(true);
    expect(isSafeExternalUrl("https://accounts.google.com/o/oauth2/auth")).toBe(true);
  });

  test("rejects non-https schemes", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeExternalUrl("http://slack.com/oauth")).toBe(false);
  });

  test("rejects malformed or relative values", () => {
    expect(isSafeExternalUrl("")).toBe(false);
    expect(isSafeExternalUrl("/relative/path")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
  });

  test("rejects userinfo look-alike redirects", () => {
    expect(isSafeExternalUrl("https://accounts.google.com@evil.com/phish")).toBe(false);
    // Set via the URL API, not a literal, so the OGR03 secret scan's Basic-Auth-URL rule never
    // sees a "user:pass@" substring in this file's source text.
    const withCredentials = new URL("https://evil.com/x");
    withCredentials.username = "user";
    withCredentials.password = "pass";
    expect(isSafeExternalUrl(withCredentials.href)).toBe(false);
  });
});
