/** Minimal trailing debouncer. Kept dependency-free so tests can drive it with
 *  fake timers. The delay may be a getter — it is read at schedule() time, so
 *  config changes take effect without rebuilding the debouncer. */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ms: number | (() => number),
    private readonly fn: () => void | Promise<void>
  ) {}

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fn();
    }, typeof this.ms === "function" ? this.ms() : this.ms);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get pending(): boolean {
    return this.timer !== null;
  }
}
