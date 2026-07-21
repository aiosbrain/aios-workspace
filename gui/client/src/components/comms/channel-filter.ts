import type { InboxDetail, InboxItem, InboxView } from "./types";

export type CommsChannel =
  "all" | "claude" | "gmail" | "slack" | "telegram" | "whatsapp" | "calendar" | "other";

export const COMMS_CHANNEL_LABELS: Record<CommsChannel, string> = {
  all: "Inbox (all)",
  claude: "Claude",
  gmail: "Gmail",
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  calendar: "Calendar",
  other: "Other",
};

interface InboxRequestToken {
  channel: CommsChannel;
  generation: number;
}

/** Invalidates responses from an older poll or a channel that is no longer selected. */
export class LatestInboxRequest {
  private channel: CommsChannel;
  private generation = 0;

  constructor(channel: CommsChannel) {
    this.channel = channel;
  }

  select(channel: CommsChannel) {
    if (channel === this.channel) return;
    this.channel = channel;
    this.generation++;
  }

  begin(channel: CommsChannel): InboxRequestToken {
    this.select(channel);
    return { channel, generation: ++this.generation };
  }

  accepts(request: InboxRequestToken): boolean {
    return request.channel === this.channel && request.generation === this.generation;
  }
}

export function channelForItem(item: InboxItem): Exclude<CommsChannel, "all"> {
  if (item.origin === "agent-event") return "claude";
  const source = [
    item.source,
    item.observation?.object_kind,
    item.observation?.connection_id,
    item.observation?.key,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (source.includes("telegram")) return "telegram";
  if (source.includes("slack")) return "slack";
  if (source.includes("whatsapp") || source.includes("wacli")) return "whatsapp";
  if (source.includes("calendar")) return "calendar";
  if (source.includes("gmail") || source.includes("email") || source.includes("gog:")) {
    return "gmail";
  }
  return "other";
}

/** Local projection only: source ingestion and server ranking remain unchanged. */
export function filterInboxView(view: InboxView, channel: CommsChannel): InboxView {
  if (channel === "all") return view;
  return { ...view, items: view.items.filter((item) => channelForItem(item) === channel) };
}

/** Bind detail-panel evidence to an item that is still visible in the current channel projection. */
export function visibleInboxSelection(
  view: InboxView | null,
  selectedId: string | null,
  detail: InboxDetail | null
) {
  const visibleId = view?.items.some((item) => item.id === selectedId) === true ? selectedId : null;
  return {
    selectedId: visibleId,
    detail: detail?.item?.id === visibleId ? detail : null,
  };
}
