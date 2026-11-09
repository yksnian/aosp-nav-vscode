/** Minimal trailing debouncer. Kept dependency-free so tests can drive it with
 *  fake timers. */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ms: number,
    private readonly fn: () => void | Promise<void>
  ) {}

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fn();
    }, this.ms);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get pending(): boolean {
    return this.timer !== null;
  }
}
