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
      if (id === this.selectedId && generation === this.generation) accept(value);
    } catch (error) {
      if (id === this.selectedId && generation === this.generation) reject(error);
    }
  }
}
