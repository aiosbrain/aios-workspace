/**
 * Shared plain-ESM process adapter for the inbox Gmail outbox.
 *
 * Policy, identity, body validation, and draft construction stay in the typed operator-loop. This
 * file owns only the GOG process boundary and its credential preflight so both CLI and GUI call the
 * same argv builder. Account and thread id are server/CLI options, never browser fields.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function commandMarker(commandId) {
  return `aios-outbox-cmd:${commandId}`;
}

/**
 * The gog CLI account ALIAS to pass as `-a`, or null to use gog's own default account.
 *
 * This is deliberately NOT the observation's `account` field. That field is an identity LABEL the
 * ingest writer stamps (it defaults to the literal "primary") and it drives dedup plus the
 * account-mismatch refusal — it is not a gog auth alias. Passing it to `-a` blindly makes every gog
 * call fail with "No auth for gmail primary." on a workspace whose gog uses an unnamed default
 * account, which fails closed as `reconcile_unavailable` and leaves the reply stuck at "Confirming…"
 * with no send and no clear reason.
 *
 * Multi-account selection is out of scope here: set `AIOS_GOG_CLI_ACCOUNT` when gog has a named
 * alias for the sending mailbox, otherwise gog's default account is used.
 */
export function gogTransportAccount(env = process.env) {
  const alias = env.AIOS_GOG_CLI_ACCOUNT;
  return typeof alias === "string" && alias.trim() ? alias.trim() : null;
}

/**
 * Bounded runner: both Sent search and send have a 60-second ceiling.
 *
 * Deliberately ASYNC. The GUI server (gui/server/index.mjs) runs one `http.createServer` event loop
 * shared with the inbox and outbox polling routes, so a synchronous spawn here would freeze every
 * other request for up to two minutes across the two calls a send makes. The command lock, not the
 * blocking call, is what serializes concurrent sends.
 */
export async function defaultRunGog(args) {
  const { stdout } = await execFileAsync("gog", args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function isTimeoutError(error) {
  return Boolean(
    error && (error.code === "ETIMEDOUT" || error.killed === true || error.signal === "SIGTERM")
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Real GOG-backed `OutboxSendClient`. The exact checked bytes are parsed by the compiled loop and
 * translated to GOG argv once. GUI replies optionally carry the server-derived native thread id;
 * this adapter never uses `--reply-all`.
 */
export function createGogSendClient(
  loop,
  { account, commandId, threadId, marker = commandMarker(commandId), runGog = defaultRunGog } = {}
) {
  const acct = account ? ["-a", account] : [];
  return {
    async querySent() {
      let out;
      try {
        out = await runGog([
          "gmail",
          "search",
          `in:sent "${marker}"`,
          "--json",
          "--results-only",
          "--max",
          "1",
          ...acct,
        ]);
      } catch (error) {
        throw new loop.OutboxReconcileError(`gog Sent search failed: ${errorMessage(error)}`);
      }
      let rows;
      try {
        rows = JSON.parse(out);
      } catch (error) {
        throw new loop.OutboxReconcileError(
          `gog Sent search returned non-JSON: ${errorMessage(error)}`
        );
      }
      if (Array.isArray(rows) && rows.length > 0) {
        return { found: true, thread_id: rows[0].threadId || rows[0].id };
      }
      return { found: false };
    },
    async send(exactOutboundBytes) {
      const message = loop.parseOutboundMessage(exactOutboundBytes);
      const args = ["gmail", "send", "--to", message.to.join(",")];
      if (message.cc.length) args.push("--cc", message.cc.join(","));
      if (message.bcc.length) args.push("--bcc", message.bcc.join(","));
      args.push("--subject", message.subject, "--body", message.body);
      if (threadId) args.push("--thread-id", threadId);
      args.push("--json", "--results-only", ...acct);

      let out;
      try {
        out = await runGog(args);
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new loop.OutboxTimeoutError(`gog send timed out: ${errorMessage(error)}`);
        }
        throw new loop.OutboxSendError(`gog send failed: ${errorMessage(error)}`);
      }
      let result;
      try {
        result = JSON.parse(out);
      } catch {
        throw new loop.OutboxSendError("gog send returned non-JSON output");
      }
      const message_id = result.id || result.messageId || result.message_id || "";
      const thread_id = result.threadId || result.thread_id || message_id;
      if (!message_id) throw new loop.OutboxSendError("gog send returned no message id");
      return { message_id, thread_id };
    },
  };
}

function gogConfigCandidates() {
  const home = os.homedir();
  return [
    path.join(home, "Library", "Application Support", "gogcli", "config.json"),
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "gogcli", "config.json"),
    path.join(home, ".config", "gog", "config.json"),
  ];
}

/** Resolve only credential storage metadata; secret bytes are never read here. */
export function resolveGogCredential(env = process.env) {
  const override = env.AIOS_GOG_TOKEN_FILE;
  if (override && override.trim()) {
    return { mode: "file", tokenPath: override.trim(), source: "AIOS_GOG_TOKEN_FILE" };
  }
  for (const cfgPath of gogConfigCandidates()) {
    let raw;
    try {
      raw = readFileSync(cfgPath, "utf8");
    } catch {
      continue;
    }
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      return {
        mode: "keyring",
        reason: `gog config at ${cfgPath} is unparseable — assuming OS-keyring backend (no token file to guard)`,
      };
    }
    const backend = String(config.keyring_backend ?? "auto").toLowerCase();
    if (backend === "file" || backend === "plaintext") {
      const tokenPath = config.token_file || config.credentials_file || config.token_path || null;
      if (tokenPath) return { mode: "file", tokenPath: String(tokenPath), source: cfgPath };
      return {
        mode: "file-unknown",
        reason: `gog config declares a file backend but no token path is discoverable in ${cfgPath}`,
      };
    }
    return {
      mode: "keyring",
      reason: `gog credential is OS-keyring-backed (keyring_backend=${backend}) — file mode/uid gate N/A; OS keyring ACL is the boundary`,
    };
  }
  return {
    mode: "keyring",
    reason: "no gog config found — assuming OS-keyring backend (no token file to guard)",
  };
}

/** Run the existing file-mode/uid credential gate, preserving named keyring/platform skips. */
export function gogTokenSecurityGate(loop, { env = process.env, platform } = {}) {
  const credential = resolveGogCredential(env);
  if (credential.mode === "keyring") {
    return { ok: true, skipped: true, reason: credential.reason };
  }
  if (credential.mode === "file-unknown") {
    const result = loop.assertGatewayTokenSecurity(
      "/nonexistent-gog-token",
      platform ? { platform } : {}
    );
    if (result.skipped) return { ok: true, skipped: true, reason: result.reason };
    return { ok: false, skipped: false, reason: credential.reason };
  }
  const result = loop.assertGatewayTokenSecurity(
    credential.tokenPath,
    platform ? { platform } : {}
  );
  if (result.skipped) {
    return { ok: true, skipped: true, reason: `${result.reason} (${credential.tokenPath})` };
  }
  if (!result.ok) {
    return { ok: false, skipped: false, reason: `${result.reason} (${credential.tokenPath})` };
  }
  return { ok: true, skipped: false, reason: `${result.reason} (${credential.tokenPath})` };
}
