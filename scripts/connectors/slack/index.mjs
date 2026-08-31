/**
 * The built-in Slack adapter behind `aios slack <verb>` (AIO-1068) — the Node replacement
 * for the Python slack.py path. Built-in Node APIs only: no python3, no jq, no global
 * dotenvx, no checkout — the packed package is the whole runtime.
 *
 * Loaded LAZILY through the scripts/connectors.mjs barrel: `aios help`/`version`/`doctor`/
 * `provenance` and the Linear surface never import it, so a broken Slack adapter is
 * quarantined to its own command surface (test/slack-adapter-quarantine.test.mjs).
 *
 * VERBS is the flow-parity matrix against slack.py: every verb, its implementing module,
 * and the credential it needs BEFORE running (`provider` = the Slack user token, resolved
 * through the shared credential broker; `brain` verbs resolve the brain themselves).
 * test/slack-command-parity.test.mjs pins it against the legacy Python surface.
 */
import { createOutput, normalizeError } from "../../cli.mjs";

/** verb → { module, credential } — the canonical Slack command surface. */
export const VERBS = Object.freeze({
  whoami: { module: "scripts/connectors/slack/verbs.mjs", credential: "provider" },
  resolve: { module: "scripts/connectors/slack/verbs.mjs", credential: "provider" },
  channels: { module: "scripts/connectors/slack/verbs.mjs", credential: "provider" },
  read: { module: "scripts/connectors/slack/verbs.mjs", credential: "provider" },
  send: { module: "scripts/connectors/slack/verbs.mjs", credential: "provider" },
  dm: { module: "scripts/connectors/slack/verbs.mjs", credential: "provider" },
  react: { module: "scripts/connectors/slack/verbs.mjs", credential: "provider" },
  file: { module: "scripts/connectors/slack/files.mjs", credential: "provider" },
  "file-delete": { module: "scripts/connectors/slack/files.mjs", credential: "provider" },
  connect: { module: "scripts/connectors/slack/setup.mjs", credential: "brain" },
  status: { module: "scripts/connectors/slack/setup.mjs", credential: "brain" },
  disconnect: { module: "scripts/connectors/slack/setup.mjs", credential: "brain" },
});

const HANDLERS = {
  whoami: async () => (await import("./verbs.mjs")).cmdWhoami,
  resolve: async () => (await import("./verbs.mjs")).cmdResolve,
  channels: async () => (await import("./verbs.mjs")).cmdChannels,
  read: async () => (await import("./verbs.mjs")).cmdRead,
  send: async () => (await import("./verbs.mjs")).cmdSend,
  dm: async () => (await import("./verbs.mjs")).cmdDm,
  react: async () => (await import("./verbs.mjs")).cmdReact,
  file: async () => (await import("./files.mjs")).cmdFile,
  "file-delete": async () => (await import("./files.mjs")).cmdFileDelete,
  connect: async () => (await import("./setup.mjs")).cmdConnect,
  status: async () => (await import("./setup.mjs")).cmdStatus,
  disconnect: async () => (await import("./setup.mjs")).cmdDisconnect,
};

// The braced verb list stays argparse-choices-shaped on purpose: existing tooling parses it.
export function slackUsage() {
  return [
    "aios slack — send/read Slack as the authenticated user (xoxp user token)",
    "",
    "verbs: {whoami,resolve,channels,read,send,dm,react,file,file-delete,connect,status,disconnect}",
    "",
    "  aios slack whoami [--json]                    auth.test → your user id / name / team",
    "  aios slack resolve <email> | --member <m>     users.lookupByEmail / brain handle → U-id",
    "  aios slack channels [--types im,...] [--json] conversations.list (paged)",
    "  aios slack read --target T [--limit N] [--thread TS]",
    "  aios slack send --target T (--message M | --message-stdin) [--thread TS]",
    "  aios slack dm (--target T | --member E) (--message M | --message-stdin) [--thread TS]",
    "  aios slack react --target T --ts TS --emoji NAME",
    "  aios slack file (--target T | --member E) --path P [--message M]",
    "    [--allow-outside-workspace]                 upload a workspace-contained local file",
    "  aios slack file-delete <FILE_ID>              delete an uploaded file (cleanup)",
    "  aios slack connect [xoxp-…|--stdin]           store YOUR user token in the Team Brain",
    "  aios slack status [--json]                    connection state (never token values)",
    "  aios slack disconnect                         remove the brain-held token",
    "",
    "target T: U…/W… (user → DM) | C…/D…/G… (channel id) | @email | email | #name",
    "token resolution: SLACK_USER_TOKEN → user-config credentialSources.slack → Team Brain",
  ].join("\n");
}

/** `aios slack <verb> …`. Returns the exit code (the registry descriptor is exit-code). */
export async function cmdSlack(repo, rest, options = {}) {
  const output = createOutput(options);
  // Global flags are accepted BEFORE the verb too — slack.py declared `--json` on both the
  // top-level parser and the shared per-verb parent, so `slack --json send …` was always
  // legal (Codex round 2). `--json`/`--help`/`-h` are the ONLY pre-verb globals the Python
  // CLI had; a hoisted --json is re-appended to the verb argv so one parser owns it. Any
  // other leading flag falls through and errors as an unknown verb, which names it.
  let cursor = 0;
  let hoistedJson = false;
  while (rest[cursor] === "--json") {
    hoistedJson = true;
    cursor += 1;
  }
  const verb = rest[cursor];
  const verbArgs = [...rest.slice(cursor + 1), ...(hoistedJson ? ["--json"] : [])];
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    console.log(slackUsage());
    return 0;
  }
  if (!VERBS[verb]) {
    const { shownArg } = await import("./args.mjs");
    console.log(slackUsage());
    // shownArg: a pasted credential in the verb slot must not be echoed into logs.
    output.diagnostic(`error: unknown slack verb: ${shownArg(verb)}`);
    return 2;
  }
  // Verb-level help NEVER resolves credentials or touches the network: on an unconfigured
  // machine `aios slack send --help` must print help and exit 0, not exit 3 after a brain
  // token fetch (Codex round 1). The handlers keep their own help path as a backstop.
  if (verbArgs.some((arg) => arg === "--help" || arg === "-h")) {
    console.log(slackUsage());
    return 0;
  }
  try {
    const ctx = {
      // Deliberately the PROCESS cwd, not the dispatch-resolved workspace root: slack.py
      // anchored workspace containment and brain-config lookup on the working directory,
      // and the compat bin (repo = null) must behave identically from any subdirectory.
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdin: options.stdin,
      fetch: options.fetch,
    };
    if (VERBS[verb].credential === "provider") {
      const { resolveBrainConfig, resolveSlackCredential } = await import("./credentials.mjs");
      // Brain config resolves lazily and is only USED (validated, then credentialed) when a
      // verb actually calls the brain — but the token may itself come from the brain root.
      ctx.brain = await resolveBrainConfig(ctx);
      ctx.token = (await resolveSlackCredential(ctx)).values.token;
    }
    const handler = await HANDLERS[verb]();
    const status = await handler(ctx, verbArgs);
    if (status === null) {
      console.log(slackUsage());
      return 0;
    }
    return status;
  } catch (error) {
    return output.failure(normalizeError(error));
  }
}
