// The status bar's transient message slot ("saved page.tsx — hot-updating…").
//
// Mirrors the DebugSession / ScmSession / EditorStatus pattern: an external
// store owned by IdeController and read through useSyncExternalStore.
//
// This is deliberately NOT part of IdeSnapshot. The `demo-status` bridge event
// carries one message per dev-server log line — hundreds during an npm install
// — so folding it into the main snapshot would re-render every useIde()
// consumer in the IDE for each line of build output.
//
// Messages auto-hide: unlike the pre-multi-root status bar, which left the last
// message sitting there indefinitely, a readout that has gone stale is worse
// than an empty slot.

const HIDE_AFTER_MS = 4000;

export class StatusMessage {
  private listeners = new Set<() => void>();
  private text: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): string | null => this.text;

  /** Show a message, replacing whatever was there, and restart the hide timer.
   * One shared timer, so a burst of messages leaves one pending hide. */
  show(text: string) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), HIDE_AFTER_MS);
    if (text === this.text) return;
    this.text = text;
    this.emit();
  }

  private hide() {
    this.timer = null;
    if (this.text === null) return;
    this.text = null;
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}