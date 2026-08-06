import { readFileSync } from "node:fs";
import path from "node:path";

import { vaultGet, vaultSet } from "./connector.mjs";
import {
  createLinearClient,
  resolveWorkspaceLinearApiKey,
} from "./linear-client.mjs";

const valueFlag = (args, name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (args[index + 1] === undefined || args[index + 1].startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return args[index + 1];
};

const repeatedFlag = (args, name) => {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) {
      if (args[index + 1] === undefined || args[index + 1].startsWith("--")) {
        throw new Error(`${name} needs a value`);
      }
      values.push(args[index + 1]);
      index++;
    }
  }
  return values;
};

const positional = (args) => {
  const values = [];
  const flagsWithValues = new Set([
    "--team",
    "--state",
    "--assignee",
    "--project",
    "--label",
    "--limit",
    "--title",
    "--description",
    "--description-file",
    "--priority",
    "--parent",
    "--body",
    "--body-file",
    "--type",
  ]);
  for (let index = 0; index < args.length; index++) {
    if (flagsWithValues.has(args[index])) {
      index++;
      continue;
    }
    if (!args[index].startsWith("--")) values.push(args[index]);
  }
  return values;
};

function readContent(args, inlineFlag, fileFlag, { stdinFlag = "--stdin" } = {}) {
  const inline = valueFlag(args, inlineFlag);
  const file = valueFlag(args, fileFlag);
  const fromStdin = args.includes(stdinFlag);
  const selected = [inline !== undefined, file !== undefined, fromStdin].filter(Boolean).length;
  if (selected > 1) throw new Error(`choose only one of ${inlineFlag}, ${fileFlag}, or ${stdinFlag}`);
  if (inline !== undefined) return inline;
  if (file !== undefined) return readFileSync(path.resolve(file), "utf8");
  if (fromStdin) return readFileSync(0, "utf8");
  return undefined;
}

function print(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item?.identifier) console.log(`${item.identifier}\t${item.state?.name || "-"}\t${item.title}`);
      else console.log(JSON.stringify(item));
    }
    return;
  }
  if (value?.identifier) {
    console.log(`${value.identifier}  ${value.title}`);
    console.log(`state: ${value.state?.name || "unassigned"}`);
    console.log(`assignee: ${value.assignee?.name || "unassigned"}`);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

async function promptSecret() {
  if (!process.stdin.isTTY) {
    throw new Error("non-interactive setup requires --api-key-stdin");
  }
  const { askViaClack } = await import("./onboard-ui.mjs");
  return String(await askViaClack("Linear personal API key: ")).trim();
}

function credential(repo, args, deps) {
  return resolveWorkspaceLinearApiKey(repo, {
    vaultGetFn: deps.vaultGetFn,
    allowEnv: args.includes("--allow-env"),
    env: deps.env,
  });
}

function clientFor(repo, args, deps) {
  const resolved = credential(repo, args, deps);
  if (!resolved.apiKey) {
    throw new Error(`Linear is not configured for ${repo}; run \`aios linear setup\``);
  }
  return { client: deps.createClient({ apiKey: resolved.apiKey }), credential: resolved };
}

export async function cmdLinear(
  repo,
  args,
  {
    createClient = createLinearClient,
    vaultGetFn = vaultGet,
    vaultSetFn = vaultSet,
    env = process.env,
    askSecret = promptSecret,
  } = {}
) {
  const sub = args[0] || "status";
  const rest = args.slice(1);
  const json = rest.includes("--json");

  if (sub === "setup") {
    const apiKey = rest.includes("--api-key-stdin")
      ? readFileSync(0, "utf8").trim()
      : await askSecret();
    if (!apiKey) throw new Error("Linear API key is required");
    const identity = await createClient({ apiKey }).getIdentity();
    if (!identity.viewer?.id) throw new Error("Linear validation did not return an authenticated user");
    vaultSetFn(repo, "LINEAR_API_KEY", apiKey);
    const result = {
      configured: true,
      credentialSource: "workspace-vault",
      workspace: repo,
      viewer: identity.viewer,
      teams: identity.teams,
    };
    print(result, json);
    return 0;
  }

  if (sub === "status") {
    const resolved = credential(repo, rest, { vaultGetFn, env });
    if (!resolved.apiKey) {
      print({ configured: false, credentialSource: "none", workspace: repo }, json);
      return 1;
    }
    const identity = await createClient({ apiKey: resolved.apiKey }).getIdentity();
    print(
      {
        configured: true,
        credentialSource: resolved.source,
        encrypted: resolved.source === "workspace-vault",
        workspace: repo,
        viewer: identity.viewer,
        teams: identity.teams,
      },
      json
    );
    return 0;
  }

  const { client } = clientFor(repo, rest, { createClient, vaultGetFn, env });
  if (sub === "list") {
    const result = await client.listWorkspaceIssues({
      team: valueFlag(rest, "--team"),
      state: valueFlag(rest, "--state"),
      assignee: valueFlag(rest, "--assignee"),
      project: valueFlag(rest, "--project"),
      label: valueFlag(rest, "--label"),
      limit: valueFlag(rest, "--limit"),
    });
    print(json ? result : result.issues, json);
    return 0;
  }

  const pos = positional(rest);
  if (sub === "get") {
    if (!pos[0]) throw new Error("usage: aios linear get TEAM-123 [--json]");
    const issue = await client.getIssue(pos[0], { full: true });
    if (!issue) throw new Error(`Linear issue not found: ${pos[0]}`);
    print(issue, json);
    return 0;
  }

  if (sub === "create") {
    const description = readContent(rest, "--description", "--description-file");
    const issue = await client.createWorkspaceIssue({
      team: valueFlag(rest, "--team"),
      title: valueFlag(rest, "--title"),
      description: description ?? "",
      state: valueFlag(rest, "--state"),
      assignee: valueFlag(rest, "--assignee"),
      priority: valueFlag(rest, "--priority"),
      parent: valueFlag(rest, "--parent"),
      project: valueFlag(rest, "--project"),
      labels: repeatedFlag(rest, "--label"),
    });
    print(issue, json);
    return 0;
  }

  if (sub === "comment") {
    if (!pos[0]) throw new Error("usage: aios linear comment TEAM-123 --body <text>");
    const body = readContent(rest, "--body", "--body-file");
    if (!body) throw new Error("comment requires --body, --body-file, or --stdin");
    print(await client.addCommentVerified(pos[0], body), json);
    return 0;
  }

  if (sub === "set-state") {
    if (!pos[0] || !pos[1]) throw new Error("usage: aios linear set-state TEAM-123 <state>");
    print(await client.updateWorkspaceIssue(pos[0], { state: pos[1] }), json);
    return 0;
  }

  if (sub === "assign") {
    if (!pos[0] || !pos[1]) throw new Error("usage: aios linear assign TEAM-123 <user|none>");
    print(await client.updateWorkspaceIssue(pos[0], { assignee: pos[1] }), json);
    return 0;
  }

  if (sub === "update") {
    if (!pos[0]) throw new Error("usage: aios linear update TEAM-123 [fields]");
    const description = readContent(rest, "--description", "--description-file");
    const labels = repeatedFlag(rest, "--label");
    print(
      await client.updateWorkspaceIssue(pos[0], {
        title: valueFlag(rest, "--title"),
        description,
        state: valueFlag(rest, "--state"),
        assignee: valueFlag(rest, "--assignee"),
        priority: valueFlag(rest, "--priority"),
        parent: valueFlag(rest, "--parent"),
        project: valueFlag(rest, "--project"),
        labels: labels.length ? labels : undefined,
      }),
      json
    );
    return 0;
  }

  if (sub === "relation" || sub === "relations") {
    const op = pos[0];
    const identifier = pos[1];
    if (op === "list" && identifier) {
      print(await client.listRelations(identifier), json);
      return 0;
    }
    if (op === "add" && identifier && pos[2]) {
      print(await client.addRelation(identifier, pos[2], valueFlag(rest, "--type") || "related"), json);
      return 0;
    }
    if ((op === "remove" || op === "delete") && identifier && pos[2]) {
      print(await client.removeRelation(identifier, pos[2]), json);
      return 0;
    }
    throw new Error(
      "usage: aios linear relation <list TEAM-123 | add TEAM-123 TEAM-456 --type blocks|duplicate|related | remove TEAM-123 RELATION_ID>"
    );
  }

  throw new Error(
    `unknown aios linear operation '${sub}' — use setup, status, list, get, create, comment, set-state, assign, update, or relation`
  );
}
