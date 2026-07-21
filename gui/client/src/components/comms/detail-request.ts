import type { InboxDetail, InboxView } from "./types";

/** Generation gate shared by clicks and poll refreshes; stale detail promises become no-ops. */
export class LatestDetailRequest {
  private selectedId: string | null = null;
  private generation = 0;

  select(id: string | null) {
    this.selectedId = id;
    this.generation++;
  }

  async load<T>(
    id: string,
    request: () => Promise<T>,
    accept: (value: T) => void,
    reject: (error: unknown) => void
  ) {
    if (id !== this.selectedId) return;
    const generation = ++this.generation;
    try {
      const value = await request();
      if (id === this.selectedId && generation === this.generation) {
        accept(value);
        return value;
      }
    } catch (error) {
      if (id === this.selectedId && generation === this.generation) reject(error);
    }
  }
}

/** Reconcile the newer selected-detail notify projection into the earlier queue fetch. */
export function reconcileDetailNotify(
  view: InboxView,
  selectedId: string | null,
  detail: InboxDetail | undefined
): InboxView {
  if (!selectedId || !view.notify || !detail?.notify) return view;
  const states = { ...view.notify.states };
  const overdue = { ...view.notify.overdue };
  delete states[selectedId];
  delete overdue[selectedId];
  Object.assign(states, detail.notify.states);
  Object.assign(overdue, detail.notify.overdue);
  return {
    ...view,
    notify: {
      ...view.notify,
      ...detail.notify,
      states,
      overdue,
    },
  };
}
