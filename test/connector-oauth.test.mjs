#!/usr/bin/env node
// test/connector-oauth.test.mjs — the OAuth branch of the connector engine (scripts/connector.mjs).
//
// Spec (no network — fetch is injected): startOAuth asks the brain for an authorize_url with the
// member key; pollOAuthStatus waits until the brain reports connected (and times out otherwise);
// postBrainToken relays a pasted token; storeOAuthConnector requires brain connected; and
// storeConnector NEVER writes an OAuth secret to the local vault while still installing the skill.
// Zero-dep. Run: node test/connector-oauth.test.mjs

import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startOAuth,
  checkOAuthStatus,
  pollOAuthStatus,
  postBrainToken,
  storeConnector,
  storeOAuthConnector,
} from "../scripts/connector.mjs";
import { readDescriptors } from "../scripts/gen-catalog.mjs";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

// Build at runtime so OGR03 secret scan doesn't match a literal xoxp- fixture.
const FAKE_USER_TOKEN = "xox" + "p-fake-user-token";
const FAKE_VAULT_TOKEN = "xox" + "p-must-not-persist";

// Build a Response-like stub the engine can `.json()`.
const reply = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

const D = readDescriptors(tmpdir())["slack-personal"];
const CFG = { brain_url: "https://brain.example", api_key: "aios_k_secret", team_id: "aios" };

async function run() {
  // ── startOAuth ───────────────────────────────────────────────────────────
  {
    const seen = {};
    const fetchImpl = async (url, init) => {
      seen.url = url;
      seen.init = init;
      return reply({ authorize_url: "https://slack.com/oauth/v2/authorize?state=xyz" });
    };
    const out = await startOAuth(D, CFG, { fetchImpl });
    check(
      "startOAuth resolves ${BRAIN_URL}",
      seen.url === "https://brain.example/api/auth/slack/start"
    );
    check("startOAuth GETs (brain contract)", seen.init.method === "GET");
    check(
      "startOAuth sends member bearer",
      seen.init.headers.Authorization === "Bearer aios_k_secret"
    );
    check("startOAuth sends X-AIOS-Team", seen.init.headers["X-AIOS-Team"] === "aios");
    check("startOAuth returns authorize_url", out.authorize_url.startsWith("https://slack.com/"));
  }

  // startOAuth surfaces a brain error
  {
    const fetchImpl = async () =>
      reply({ message: "Slack OAuth not configured" }, { ok: false, status: 500 });
    let threw = false;
    try {
      await startOAuth(D, CFG, { fetchImpl });
    } catch (e) {
      threw = /not configured/.test(e.message);
    }
    check("startOAuth throws on non-200", threw);
  }

  // ── checkOAuthStatus ─────────────────────────────────────────────────────
  {
    const fetchImpl = async (url) => {
      check("status resolves ${BRAIN_URL}", url === "https://brain.example/api/auth/slack/status");
      return reply({ connected: true, slack_user_id: "U123", workspace: "Acme" });
    };
    const st = await checkOAuthStatus(D, CFG, { fetchImpl });
    check(
      "status maps connected/user/workspace",
      st.connected && st.slack_user_id === "U123" && st.workspace === "Acme"
    );
  }

  // ── pollOAuthStatus: resolves once the brain flips to connected ────────────
  {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return reply(
        calls >= 2 ? { connected: true, slack_user_id: "U9", workspace: "W" } : { connected: false }
      );
    };
    const st = await pollOAuthStatus(D, CFG, { fetchImpl, timeoutMs: 5000, intervalMs: 1 });
    check("poll resolves when connected", st.connected && calls >= 2);
  }

  // ── pollOAuthStatus: times out when never connected ────────────────────────
  {
    const fetchImpl = async () => reply({ connected: false });
    let code = null;
    try {
      await pollOAuthStatus(D, CFG, { fetchImpl, timeoutMs: 30, intervalMs: 10 });
    } catch (e) {
      code = e.code;
    }
    check("poll throws oauth_timeout", code === "oauth_timeout");
  }

  // ── postBrainToken: relays a pasted token ──────────────────────────────────
  {
    const seen = {};
    const fetchImpl = async (url, init) => {
      seen.url = url;
      seen.body = JSON.parse(init.body);
      return reply({ ok: true, slack_user_id: "U1", workspace: "Acme" });
    };
    const out = await postBrainToken(D, CFG, FAKE_USER_TOKEN, { fetchImpl });
    check(
      "postBrainToken hits store_url",
      seen.url === "https://brain.example/api/v1/me/slack-token"
    );
    check("postBrainToken sends { token }", seen.body.token === FAKE_USER_TOKEN);
    check("postBrainToken returns brain identity", out.slack_user_id === "U1");
  }

  // postBrainToken rejects a bad token
  {
    const fetchImpl = async () =>
      reply({ error: "invalid_token", message: "rejected" }, { ok: false, status: 422 });
    let threw = false;
    try {
      await postBrainToken(D, CFG, "nope", { fetchImpl });
    } catch (e) {
      threw = /rejected/.test(e.message);
    }
    check("postBrainToken throws on 422", threw);
  }

  // ── storeOAuthConnector: refuses when brain not connected ─────────────────
  {
    const fetchImpl = async () => reply({ connected: false });
    let code = null;
    try {
      await storeOAuthConnector(mkdtempSync(path.join(tmpdir(), "oauthrepo-")), D, CFG, {
        fetchImpl,
      });
    } catch (e) {
      code = e.code;
    }
    check("storeOAuthConnector throws oauth_not_connected", code === "oauth_not_connected");
  }

  // ── storeConnector: OAuth secret never hits the local vault ────────────────
  {
    const repo = mkdtempSync(path.join(tmpdir(), "oauthrepo-"));
    const stored = storeConnector(repo, D, { SLACK_USER_TOKEN: FAKE_VAULT_TOKEN });
    check("storeConnector flips wired", stored.status === "wired");
    check("no local .env written (token stays in the brain)", !existsSync(path.join(repo, ".env")));
    check(
      "skill installed to .claude/skills/slack-personal/",
      existsSync(path.join(repo, ".claude", "skills", "slack-personal", "SKILL.md"))
    );
  }
}

run()
  .then(() => {
    console.log("================================================");
    if (failed === 0) {
      console.log(`${GREEN}connector-oauth tests PASSED${NC}`);
      process.exit(0);
    }
    console.log(`${RED}connector-oauth tests FAILED — ${failed} assertion(s)${NC}`);
    process.exit(1);
  })
  .catch((e) => {
    console.error(`${RED}connector-oauth tests ERRORED${NC}`, e);
    process.exit(1);
  });
