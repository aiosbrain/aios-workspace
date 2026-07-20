// Guards the OAuth authorize URL before it hits window.open (SonarCloud tssecurity:S6105 —
// DOM open redirect). The brain returns a different provider domain per connector, so the
// check can't pin one host; it only rejects non-https schemes/malformed values.

import { describe, test, expect, vi } from "vitest";

vi.mock("../../state/cockpit", () => ({ useConnection: () => ({ api: {} }) }));

import { isSafeAuthorizeUrl } from "./ConnectWizard";

describe("isSafeAuthorizeUrl", () => {
  test("accepts https provider URLs", () => {
    expect(isSafeAuthorizeUrl("https://slack.com/oauth/v2/authorize?state=xyz")).toBe(true);
    expect(isSafeAuthorizeUrl("https://accounts.google.com/o/oauth2/auth")).toBe(true);
  });

  test("rejects non-https schemes", () => {
    expect(isSafeAuthorizeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeAuthorizeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeAuthorizeUrl("http://slack.com/oauth")).toBe(false);
  });

  test("rejects malformed or relative values", () => {
    expect(isSafeAuthorizeUrl("")).toBe(false);
    expect(isSafeAuthorizeUrl("/relative/path")).toBe(false);
    expect(isSafeAuthorizeUrl("not a url")).toBe(false);
  });
});
