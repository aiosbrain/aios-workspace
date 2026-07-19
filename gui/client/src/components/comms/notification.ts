/**
 * Content-free desktop notifications (I-14 / AIO-395) — the Tauri/desktop lane for a new blocking ask.
 *
 * The projection rule is I-05's: the notification carries NO comms plaintext (no subject, sender, snippet,
 * or ask title, no operation args) — only a coarse category and a deep link keyed by the opaque item id.
 * That way a phone/desktop banner is safe on any surface. Fired through the browser Notification API,
 * which the Tauri webview also honors, so no new dependency is added.
 */

import type { InboxItem, InboxView } from "./types";

export interface InboxNotification {
  title: string;
  body: string;
  /** Deep link into the item; the only id that crosses the wire. */
  deepLink: string;
}

/** The deep-link shape a content-free notification must use — asserted by the notification test. */
export const CONTENT_FREE_DEEPLINK_RE = /^aios:\/\/inbox\/[^/\s]+$/;

/** A blocking ask = an agent escalation that needs the human now (open blocker / protected partition). */
export function isBlockingAsk(item: InboxItem): boolean {
  return item.origin === "agent-event" && (item.bucket === "needs-you" || item.protected);
}

/**
 * Build the CONTENT-FREE notification payload for an item. Deliberately constructed from ONLY the coarse
 * origin + the opaque id — never the ask title, thread snippet, sender, or any operation argument.
 */
export function contentFreeNotification(item: InboxItem): InboxNotification {
  const body =
    item.origin === "agent-event"
      ? "An agent is waiting on your approval."
      : "A message needs you.";
  return {
    title: "AIOS · needs you",
    body,
    deepLink: `aios://inbox/${item.id}`,
  };
}

/**
 * Diff two queue reads and fire a content-free notification for every NEWLY-appeared blocking ask. Pure
 * apart from the injected `fire` sink (the browser Notification by default), so the dev harness / test can
 * assert exactly what would be shown. Returns the payloads fired.
 */
export function notifyNewBlockingAsks(
  seenIds: ReadonlySet<string>,
  view: InboxView,
  fire: (n: InboxNotification) => void
): InboxNotification[] {
  const fired: InboxNotification[] = [];
  for (const item of view.items) {
    if (!isBlockingAsk(item) || seenIds.has(item.id)) continue;
    const n = contentFreeNotification(item);
    fire(n);
    fired.push(n);
  }
  return fired;
}

/** Default sink: the desktop notification, guarded by feature-detection + permission. Best-effort. */
export function desktopNotify(n: InboxNotification): void {
  if (typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "granted") {
      new Notification(n.title, { body: n.body, tag: n.deepLink });
    } else if (Notification.permission === "default") {
      // The triggering ask is already in the caller's seen-set by the time permission resolves, so it
      // would otherwise NEVER banner. Fire it here once the user grants — content-free, so replaying
      // the payload after the prompt is safe.
      void Notification.requestPermission()
        .then((permission) => {
          if (permission === "granted") {
            new Notification(n.title, { body: n.body, tag: n.deepLink });
          }
        })
        .catch(() => {
          /* denied/unavailable — stay silent */
        });
    }
  } catch {
    /* notifications are additive — never let a banner failure break the queue */
  }
}
