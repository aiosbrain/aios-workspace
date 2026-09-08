import type { ChildProcess } from "node:child_process";

// Detached connector groups belong to the daily invocation, including on interruption
// and ordinary process.exit. Install hooks only while at least one child is owned.
const children = new Set<ChildProcess>();

function stop(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  } catch {
    // A child/group that has already exited needs no further cleanup.
  }
}

function stopAll(): void {
  for (const child of children) stop(child);
}

function interrupt(signal: "SIGINT" | "SIGTERM"): void {
  stopAll();
  // A host that already handles this signal retains control of its own shutdown.
  // Otherwise restore Node's default signal behavior after terminating owned groups.
  if (process.listenerCount(signal) === 1) {
    uninstall();
    process.kill(process.pid, signal);
  }
}

const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");

function uninstall(): void {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
  process.removeListener("exit", stopAll);
}

export function ownConnector(child: ChildProcess): () => void {
  if (children.size === 0) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    process.on("exit", stopAll);
  }
  children.add(child);
  return () => {
    // A leader exiting must not leave a delegated process alive in its group.
    stop(child);
    children.delete(child);
    if (children.size === 0) uninstall();
  };
}
