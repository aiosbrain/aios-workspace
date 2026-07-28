/**
 * The one useful sentence out of a failed subprocess.
 *
 * A failed Team Brain push used to toast the whole `execFile` string — absolute node path, script
 * path, every selected file, the `--repo` path — with the actual cause LAST, so the toast was ~10
 * unreadable lines (audit S5-9). The full text still lands in the output pane; the toast gets the
 * cause. Lives here rather than beside the component so it is unit-testable without a DOM.
 */
export function briefError(message: string): string {
  const marker = message.lastIndexOf("error:");
  const tail = marker === -1 ? message : message.slice(marker + "error:".length);
  const line = tail.split("\n").find((l) => l.trim().length > 0) ?? message;
  const flat = line.trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}
