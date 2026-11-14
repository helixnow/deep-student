/** vfs/hooks.rs NoteDeleteHook 的 Host 侧 HookSet。 */
import type { Disposer, NoteDeleteHook, ResourceCreatedHook, VfsHandlersHooks, VfsResourceCreatedHooks } from '../api.ts';

export class NoteDeleteHookSet implements VfsHandlersHooks, VfsResourceCreatedHooks {
  readonly version = 1 as const;
  _hooks: NoteDeleteHook[] = [];
  private readonly resourceHooks = new Set<{ hook: ResourceCreatedHook }>();

  registerResourceCreatedHook(hook: ResourceCreatedHook): Disposer {
    const registration = { hook };
    this.resourceHooks.add(registration);
    return () => { this.resourceHooks.delete(registration); };
  }

  /** hooks.rs:130-136: snapshot first; mutations during callbacks affect the next notification. */
  notifyResourceCreated(resourceId: string): void {
    for (const { hook } of [...this.resourceHooks]) hook.onResourceCreated(resourceId);
  }

  registerNoteDeleteHook(hook: NoteDeleteHook): Disposer {
    this._hooks.push(hook);
    return () => {
      const index = this._hooks.indexOf(hook);
      if (index >= 0) this._hooks.splice(index, 1);
    };
  }

  /** Rust HookSet::snapshot 后 filter_map(capture_delete)。 */
  capture(noteId: string): Array<() => void> {
    const continuations: Array<() => void> = [];
    for (const hook of [...this._hooks]) {
      const continuation = hook.captureDelete(noteId);
      if (continuation !== null) continuations.push(continuation);
    }
    return continuations;
  }
}
