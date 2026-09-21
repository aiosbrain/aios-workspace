/**
 * Test-only `node --import` preload for the MCP host acceptance journey. It lets the
 * journey drive the INSTALLED public CLI (`node <pkg>/scripts/aios.mjs …`) with no product
 * seam: production modules are untouched and unaware of it. It fixtures exactly two OS
 * boundaries and nothing else:
 *
 *  1. Process discovery (AIOS_ACCEPTANCE_PROCESS_LIST=<json file>). The installer's
 *     running-host check shells out to `ps -axo command=` (POSIX) or a PowerShell
 *     `Get-CimInstance Win32_Process` query (Windows). Only those two invocations are
 *     answered from the fixture list; every other child process (the real MCP server,
 *     PowerShell ACL reads, taskkill, git) runs for real. Without this, the result would
 *     depend on which applications the machine happens to have open — and it must never
 *     be "fixed" by quitting a user's applications. Each interception is appended to
 *     AIOS_ACCEPTANCE_PROCESS_LOG so the journey can prove the check actually ran.
 *
 *  2. Terminal (AIOS_ACCEPTANCE_SCRIPTED_TTY=1). `aios onboard` refuses a non-TTY stdin.
 *     The journey answers the real clack prompts over a pipe, so stdin is marked as a
 *     terminal and raw mode becomes a no-op. Prompt code, rendering, key handling and all
 *     onboarding orchestration are the installed production code.
 *
 * Both switches are read once and removed from the environment, so no child inherits them.
 */
import childProcess from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const listFile = process.env.AIOS_ACCEPTANCE_PROCESS_LIST;
const logFile = process.env.AIOS_ACCEPTANCE_PROCESS_LOG;
const scriptedTty = process.env.AIOS_ACCEPTANCE_SCRIPTED_TTY === "1";
for (const name of [
  "AIOS_ACCEPTANCE_PROCESS_LIST",
  "AIOS_ACCEPTANCE_PROCESS_LOG",
  "AIOS_ACCEPTANCE_SCRIPTED_TTY",
])
  delete process.env[name];

if (listFile) {
  const real = childProcess.execFileSync;
  childProcess.execFileSync = function execFileSync(file, args, options) {
    const posix =
      file === "ps" && Array.isArray(args) && args.length === 2 && args[1] === "command=";
    const windows =
      path.win32.basename(String(file)).toLowerCase() === "powershell.exe" &&
      Array.isArray(args) &&
      String(args.at(-1)).includes("Get-CimInstance Win32_Process");
    if (!posix && !windows) return real.call(this, file, args, options);
    const list = JSON.parse(readFileSync(listFile, "utf8"));
    if (logFile) appendFileSync(logFile, `${posix ? "ps" : "powershell"}\n`);
    return windows ? JSON.stringify(list) : `${list.join("\n")}\n`;
  };
  syncBuiltinESMExports();
}

if (scriptedTty) {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  process.stdin.setRawMode = () => process.stdin;
}
