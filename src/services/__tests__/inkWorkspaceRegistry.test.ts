import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushInkWorkspace, hasInkWorkspace, registerInkWorkspaceExitGuard } from '../inkWorkspaceRegistry';

const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); });

function deferred() {
  let resolve!: (saved: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('ink workspace exit registry', () => {
  it('normalizes resource paths and allows an unmounted non-ink file to close', async () => {
    expect(hasInkWorkspace('/folder/file_plain')).toBe(false);
    await expect(flushInkWorkspace('/folder/file_plain')).resolves.toBe(true);
    const stop = registerInkWorkspaceExitGuard('file_ink', { isDirty: () => false, flush: async () => true });
    disposers.push(stop);
    expect(hasInkWorkspace('/folder/file_ink')).toBe(true);
    await expect(flushInkWorkspace('/folder/file_ink')).resolves.toBe(true);
    stop();
    expect(hasInkWorkspace('file_ink')).toBe(false);
  });

  it('awaits a clean-looking active gesture and rechecks whether it is dirty', async () => {
    const pending = deferred();
    let dirty = false;
    const flush = vi.fn(() => pending.promise);
    disposers.push(registerInkWorkspaceExitGuard('file_gesture', { isDirty: () => dirty, flush }));
    let settled = false;
    const saving = flushInkWorkspace('file_gesture').then((saved) => { settled = true; return saved; });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    dirty = true;
    pending.resolve(true);
    await expect(saving).resolves.toBe(false);
  });

  it.each(['reject', 'throw'] as const)('fails closed when a guard returns %s', async (mode) => {
    disposers.push(registerInkWorkspaceExitGuard('file_failed', {
      isDirty: () => false,
      flush: async () => {
        if (mode === 'throw') throw new Error('save failed');
        return false;
      },
    }));
    await expect(flushInkWorkspace('file_failed')).resolves.toBe(false);
    expect(hasInkWorkspace('file_failed')).toBe(true);
  });

  it('rejects a successful stale result when the workspace generation is replaced', async () => {
    const pending = deferred();
    const stop = registerInkWorkspaceExitGuard('file_replaced', { isDirty: () => false, flush: () => pending.promise });
    disposers.push(stop);
    const saving = flushInkWorkspace('file_replaced');
    stop();
    disposers.push(registerInkWorkspaceExitGuard('file_replaced', { isDirty: () => false, flush: async () => true }));
    pending.resolve(true);
    await expect(saving).resolves.toBe(false);
    await expect(flushInkWorkspace('file_replaced')).resolves.toBe(true);
  });

  it('flushes multiple workspace guards sequentially and stops on failure', async () => {
    const pending = deferred();
    const second = vi.fn(async () => true);
    disposers.push(registerInkWorkspaceExitGuard('file_shared', { isDirty: () => false, flush: () => pending.promise }));
    disposers.push(registerInkWorkspaceExitGuard('file_shared', { isDirty: () => false, flush: second }));
    const saving = flushInkWorkspace('file_shared');
    expect(second).not.toHaveBeenCalled();
    pending.resolve(false);
    await expect(saving).resolves.toBe(false);
    expect(second).not.toHaveBeenCalled();
  });
});
