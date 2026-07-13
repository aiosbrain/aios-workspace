/**
 * member-cli.mjs — `aios member` (brain-api v1.7 `POST /api/v1/members/invite` +
 * `GET /api/v1/members`).
 *
 * `aios member invite <email> --name <n> --handle <h> [--role r] [--tools t1,t2|all|none]`
 * creates/re-invites a team member and best-effort cascades invitations to the team's
 * configured tools (Linear/Slack/GitHub). `aios member list` reads the roster.
 *
 * Kept out of the 5000+-line scripts/aios.mjs per the ongoing AIO-315 decomposition
 * (see mode.mjs, roadmap-run.mjs, ship.mjs for the same pattern). `deps.api` is
 * `(method, route, body) => Promise<json>` — a cfg-bound partial of aios.mjs's
 * `api(cfg, method, route, body)` — so tests can inject a stub with no network.
 */

import { c, die } from "./cli-common.mjs";

const ROLES = new Set(["member", "lead", "admin"]);
// Exported for the contract-conformance guard: must match the fixture's provisioningTools.
export const TOOLS = new Set(["linear", "slack", "github"]);

const INVITE_USAGE =
  "usage: aios member invite <email> --name <display name> --handle <handle> " +
  "[--role member|lead|admin] [--tools linear,slack,github|all|none]";

const USAGE = `aios member — Team Brain roster + onboarding (contract: docs/brain-api.md v1.7)

usage:
  ${INVITE_USAGE}
  aios member list                      list team roster (GET /members)`;

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

// Mirrors aios.mjs's requireOnline(cfg) exactly (member is an online-only, brain-key
// command like whoami/query — duplicated here rather than exported across the module
// boundary since it's two lines and this module has no other coupling to aios.mjs).
function requireOnline(cfg) {
  if (!cfg.brain_url) {
    die("aios.yaml has no brain_url (offline/standalone mode). Set brain_url or AIOS_BRAIN_URL.");
  }
  if (!cfg.api_key) {
    die(`no API key found in $${cfg.api_key_env || "AIOS_API_KEY"} (env or .env)`);
  }
}

/** Parse --tools into the wire value: "all"/"none" pass through; else a validated array. */
function parseTools(raw) {
  if (raw == null) return "all";
  if (raw === "all" || raw === "none") return raw;
  const tools = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tools.length) die(`--tools must be a comma-separated list, "all", or "none"`);
  for (const t of tools) {
    if (!TOOLS.has(t)) {
      die(`unknown --tools value "${t}" — must be one of: linear, slack, github, all, none`);
    }
  }
  return tools;
}

const STATUS_GLYPH = { sent: "✓", link_provided: "🔗", skipped: "–", failed: "✗" };
const STATUS_COLOR = { sent: "green", link_provided: "blue", skipped: "dim", failed: "red" };

function printProvisioning(entries) {
  for (const p of entries || []) {
    const glyph = STATUS_GLYPH[p.status] || "?";
    const color = STATUS_COLOR[p.status] || "dim";
    const line = `  ${c[color](glyph)} ${p.tool.padEnd(8)} ${p.status}${p.detail ? c.dim(` — ${p.detail}`) : ""}`;
    console.log(line);
    if (p.status === "link_provided" && p.invite_link) {
      console.log(`      ${c.dim(p.invite_link)}`);
    }
  }
}

async function cmdMemberInvite(rest, deps) {
  const email = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
  const name = flagValue(rest, "--name");
  const handle = flagValue(rest, "--handle");
  const roleArg = flagValue(rest, "--role");
  const toolsArg = flagValue(rest, "--tools");

  if (!email || !email.includes("@")) die(`a valid <email> is required\n\n${INVITE_USAGE}`);
  if (!name) die(`--name is required\n\n${INVITE_USAGE}`);
  if (!handle) die(`--handle is required\n\n${INVITE_USAGE}`);
  const role = roleArg || "member";
  if (!ROLES.has(role)) die(`--role must be one of: member, lead, admin (got "${role}")`);
  const tools = parseTools(toolsArg);

  const body = {
    email,
    display_name: name,
    actor_handle: handle,
    role,
    tools,
  };

  let res;
  try {
    res = await deps.api("POST", "/members/invite", body);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/^404\b/.test(msg)) {
      die(
        "this Team Brain predates brain-api v1.7 member invites — update aios-team-brain, " +
          "or invite from the dashboard's /admin/members page."
      );
    }
    if (/^403\b/.test(msg)) {
      die("your API key's member must be a team admin to invite members");
    }
    throw e;
  }

  const member = res.member || {};
  console.log(
    `${c.green("✓")} ${member.email}${member.created ? " created" : " already existed (re-invited)"} — status: ${member.status}`
  );

  const invite = res.invite || {};
  if (invite.mode === "magic-link") {
    if (invite.email_delivered) {
      console.log(`  magic-link sent to ${member.email}`);
    } else {
      console.log(
        `  ${c.yellow("email delivery FAILED")} — share this sign-in link: ${invite.login_url}`
      );
    }
  } else if (invite.mode === "manual") {
    console.log("");
    console.log(invite.invite_message);
    console.log("");
  }

  printProvisioning(res.provisioning);

  // AIO-354: comms-config.json is stamped by scaffold-project.sh but ships with an
  // empty `channels` map (default-deny, clean no-op) — a real admin has to fill in
  // channel names before Slack dispatch does anything. Point at it right where the
  // Slack invite cascade happened, since that's the natural moment to wire it up.
  const invitedSlack = tools === "all" || (Array.isArray(tools) && tools.includes("slack"));
  if (invitedSlack) {
    console.log("");
    console.log(`  ${c.dim("Slack dispatch is still off by default — add real channel names to")}`);
    console.log(`  ${c.dim('.aios/comms-config.json\'s "channels" map to turn it on.')}`);
  }
}

async function cmdMemberList(deps) {
  const res = await deps.api("GET", "/members", null);
  const members = res.members || [];
  if (!members.length) {
    console.log(c.dim("no members found."));
    return;
  }
  const rows = members.map((m) => ({
    handle: m.actor_handle || "",
    name: m.display_name || "",
    email: m.email || "",
    role: m.role || "",
    tier: m.tier || "",
    identities: (m.identities || []).map((i) => i.provider).join(","),
  }));
  const width = (key, label) => Math.max(label.length, ...rows.map((r) => String(r[key]).length));
  const w = {
    handle: width("handle", "HANDLE"),
    name: width("name", "NAME"),
    email: width("email", "EMAIL"),
    role: width("role", "ROLE"),
    tier: width("tier", "TIER"),
  };
  console.log(
    `${"HANDLE".padEnd(w.handle)}  ${"NAME".padEnd(w.name)}  ${"EMAIL".padEnd(w.email)}  ${"ROLE".padEnd(w.role)}  ${"TIER".padEnd(w.tier)}  IDENTITIES`
  );
  for (const r of rows) {
    console.log(
      `${r.handle.padEnd(w.handle)}  ${r.name.padEnd(w.name)}  ${r.email.padEnd(w.email)}  ${r.role.padEnd(w.role)}  ${r.tier.padEnd(w.tier)}  ${r.identities}`
    );
  }
}

/**
 * cmdMember(repo, cfg, rest, deps) — `repo` is unused (member is a plain brain-key call,
 * no workspace state) but kept for signature parity with the other extracted `cmd*`
 * modules. `cfg` supplies brain_url/api_key (validated via requireOnline, like
 * whoami/query/stakeholders).
 */
export async function cmdMember(repo, cfg, rest, deps = {}) {
  const sub = rest[0];
  if (sub !== "invite" && sub !== "list") {
    console.log(USAGE);
    process.exit(1);
    return;
  }
  requireOnline(cfg);
  if (sub === "invite") return cmdMemberInvite(rest.slice(1), deps);
  return cmdMemberList(deps);
}
