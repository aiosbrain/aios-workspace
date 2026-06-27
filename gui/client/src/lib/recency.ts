import type { SessionSummary } from "../types/protocol";

export interface ChatGroup {
  label: string;
  chats: SessionSummary[];
}

function ts(c: SessionSummary): number {
  return new Date(c.updatedAt || c.createdAt || 0).getTime();
}

/** Sort chats newest-first and bucket them into Today / Yesterday / This week / Older. */
export function groupChatsByRecency(chats: SessionSummary[]): ChatGroup[] {
  const sorted = [...chats].sort((a, b) => ts(b) - ts(a));
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  const startYesterday = startToday - DAY;
  const startWeek = startToday - 6 * DAY;

  const order = ["Today", "Yesterday", "This week", "Older"] as const;
  const buckets: Record<string, SessionSummary[]> = {
    Today: [],
    Yesterday: [],
    "This week": [],
    Older: [],
  };
  for (const c of sorted) {
    const t = ts(c);
    if (t >= startToday) buckets.Today.push(c);
    else if (t >= startYesterday) buckets.Yesterday.push(c);
    else if (t >= startWeek) buckets["This week"].push(c);
    else buckets.Older.push(c);
  }
  return order.filter((label) => buckets[label].length).map((label) => ({ label, chats: buckets[label] }));
}
