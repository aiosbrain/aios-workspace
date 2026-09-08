import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let exchange;

// Preserve the actual displaced inode, including an edit made after the final
// source check. A plain rename destroys that evidence. Unsupported filesystems
// fail closed; there is no overwrite-rename fallback.
export function atomicHostReplace(temporary, target, recovery, existed) {
  if (!existed) {
    fs.linkSync(temporary, target); // Exclusive creation: never overwrite a racer.
    return null;
  }
  if (!exchange) {
    const koffi = require("koffi");
    if (process.platform === "darwin") {
      const lib = koffi.load("/usr/lib/libSystem.B.dylib");
      const rename = lib.func(
        "int renamex_np(const char *from, const char *to, unsigned int flags)"
      );
      exchange = (from, to) => {
        if (rename(from, to, 2) !== 0) throw new Error("Atomic file exchange failed");
        return from;
      };
    } else if (process.platform === "linux") {
      const lib = koffi.load(null);
      const rename = lib.func(
        "int renameat2(int oldfd, const char *from, int newfd, const char *to, unsigned int flags)"
      );
      exchange = (from, to) => {
        if (rename(-100, from, -100, to, 2) !== 0) throw new Error("Atomic file exchange failed");
        return from;
      };
    } else if (process.platform === "win32") {
      const lib = koffi.load("kernel32.dll");
      const replace = lib.func(
        "int __stdcall ReplaceFileW(str16 target, str16 replacement, str16 backup, uint32_t flags, void *exclude, void *reserved)"
      );
      const lastError = lib.func("uint32_t __stdcall GetLastError()");
      exchange = (from, to, backup) => {
        if (!replace(to, from, backup, 0, null, null))
          throw new Error(
            `Atomic file replacement failed (${lastError()}); inspect recovery: ${backup}`
          );
        return backup;
      };
    } else throw new Error("Atomic MCP installation is unsupported on this platform");
  }
  return exchange(temporary, target, recovery);
}
