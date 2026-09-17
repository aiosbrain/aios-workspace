import { listConnectors, getDescriptor } from "./connector.mjs";
import { c, die } from "./cli-common.mjs";

export async function cmdConnect(repo, args, { connectFlow }) {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.log(c.blue("connectable integrations:"));
    for (const conn of listConnectors(repo)) {
      const badge = conn.status === "wired" ? c.green("✓ wired") : c.dim("○ available");
      // AIO-356: dual-auth connectors (Granola) report which auth path is active.
      const authNote = conn.auth_path ? c.dim(` (auth: ${conn.auth_path.label})`) : "";
      console.log(
        `  ${conn.id.padEnd(12)} ${badge}  ${c.dim(`[${conn.transport}] ${conn.summary}`)}${authNote}`
      );
    }
    console.log(c.dim("\nrun: aios connect <id>"));
    return;
  }
  // AIO-1067 user-level linear setup (credential REFERENCE mode): setup.mjs returns an
  // exit code when it handled the request; undefined falls through to the vault flow.
  const lin = id === "linear" && (await (await import("./connectors.mjs")).loadLinearSetup());
  const handled = lin ? await lin.cmdConnectLinear(repo, args) : undefined;
  if (handled !== undefined) return void (handled && (process.exitCode = handled));
  let d;
  try {
    d = getDescriptor(repo, id);
  } catch (e) {
    die(e.message);
  }
  // collect secret values: --token sets the primary required secret; --set ENV=VALUE for others.
  const sets = {};
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--set" && args[i + 1]) {
      const [k, ...v] = args[i + 1].split("=");
      sets[k] = v.join("=");
    }
  const tokenFlag = args.includes("--token") ? args[args.indexOf("--token") + 1] : null;

  // Interactively prompted secrets (not covered by --set/--token) get masked input too — the
  // same connectFlow the onboarding wizard drives (plaintext-echo fix applies standalone too).
  const ask = process.stdin.isTTY ? (await import("./onboard-ui.mjs")).askViaClack : undefined;
  const ok = await connectFlow(repo, d, { sets, tokenFlag, ask });
  if (!ok) process.exitCode = 1;
}
