/**
 * `aios slack connect|status|disconnect` (AIO-1068) — the brain-held token lifecycle,
 * ported from slack.py. The brain validates a connect token against Slack and stores it;
 * thereafter the adapter's team-brain credential root fetches it automatically.
 *
 * The brain DESTINATION is validated before the bearer key (and, on connect, the Slack
 * token body) is sent — brainRequest routes through trustedFetch.
 */
import { AiosError } from "../../cli.mjs";
import { parseVerbArgs } from "./args.mjs";
import { assertTokenShape, describeSlackCredential, resolveBrainConfig } from "./credentials.mjs";
import { brainRequest } from "./web.mjs";

const print = (line) => process.stdout.write(`${line}\n`);

async function readStdin(stdin = process.stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Resolve a connect token without leaving it in argv when --stdin or env is used. */
async function connectToken(args, ctx) {
  if (args.stdin) return readStdin(ctx.stdin);
  if (args.token) return args.token.trim();
  return (ctx.env ?? process.env).SLACK_USER_TOKEN?.trim() ?? "";
}

export async function cmdConnect(ctx, argv) {
  const args = parseVerbArgs(argv, { flags: { stdin: "boolean" }, positional: "token" });
  if (args.help) return null;
  const token = await connectToken(args, ctx);
  if (!token) {
    throw new AiosError(
      "AIOS_E_USAGE",
      "No Slack USER token provided.",
      "Run `aios slack connect --stdin`, `SLACK_USER_TOKEN=… aios slack connect`, or " +
        "`aios slack connect xoxp-…` (prefer --stdin to keep it out of shell history)."
    );
  }
  assertTokenShape(token);
  if (!token.startsWith("xoxp-")) {
    throw new AiosError(
      "AIOS_E_USAGE",
      "The token must be a Slack USER token (xoxp-…).",
      "Bot (xoxb-) tokens belong to the gateway, never to this CLI."
    );
  }
  const brain = await resolveBrainConfig(ctx);
  const { status, body } = await brainRequest(
    brain,
    "POST",
    "/api/v1/me/slack-token",
    { token },
    ctx
  );
  if (status >= 400 || !body?.ok) {
    const detail =
      (typeof body?.error === "object" ? body?.error?.message : body?.error) ?? `HTTP ${status}`;
    throw new AiosError(
      "AIOS_E_PROVIDER",
      `Connect failed: ${detail}`,
      "Check the token (a fresh xoxp- user token) and the brain configuration, then retry."
    );
  }
  if (args.json) print(JSON.stringify(body));
  else print(`connected as ${body.slack_user_id} in workspace ${body.workspace}`);
  return 0;
}

export async function cmdStatus(ctx, argv) {
  const args = parseVerbArgs(argv);
  if (args.help) return null;
  const brain = await resolveBrainConfig(ctx);
  if (!brain.url || !brain.key) {
    // No brain: still a useful status — report the local credential source class instead
    // of dying, so `aios slack status` works in an env-token-only setup.
    const report = await describeSlackCredential(ctx);
    if (args.json) print(JSON.stringify({ connected: false, brain: false, ...report }));
    else if (report.configured)
      print(`no team brain configured; token source: ${report.source.name}`);
    else print("not connected — set SLACK_USER_TOKEN or configure the Team Brain");
    return 0;
  }
  const { status, body } = await brainRequest(
    brain,
    "GET",
    "/api/v1/me/slack-token",
    undefined,
    ctx
  );
  const connected = status < 400 && Boolean(body?.connected);
  const out = {
    connected,
    slack_user_id: body?.slack_user_id,
    workspace: body?.workspace,
  };
  if (args.json) print(JSON.stringify(out));
  else if (connected) print(`connected as ${out.slack_user_id} in ${out.workspace}`);
  else print("not connected — run: aios slack connect xoxp-…");
  return 0;
}

export async function cmdDisconnect(ctx, argv) {
  const args = parseVerbArgs(argv);
  if (args.help) return null;
  const brain = await resolveBrainConfig(ctx);
  await brainRequest(brain, "DELETE", "/api/v1/me/slack-token", undefined, ctx);
  print("disconnected");
  return 0;
}
