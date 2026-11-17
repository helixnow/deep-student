import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '../kernel';
import { runSlotCallback, SlotEntryScope } from '../outlet';
import { UiKernelProvider } from '../react';
import { UiErrorBudget } from '../services/errors';
import type { SlotEntry } from '../slots';

afterEach(cleanup);

const ID = 'community.versioned';
const plugin = (version: string) => defineUiPlugin({ meta: { id: ID, version }, apply(ctx) {
  ctx.ui.views.register({ id: 'versioned', titleKey: 'title', component: () => null });
} });

async function observer(kernel: UiKernel) {
  const failures = vi.fn();
  await kernel.install(defineUiPlugin({ meta: { id: 'dstu.recovery-test' }, apply(ctx) {
    ctx.effect(() => ctx.ui.onPluginError(failures));
  } }), { origin: 'builtin' });
  return failures;
}

describe('UI error release identity', () => {
  it('preserves an old callback version across replacement and never spends the new release error budget', async () => {
    const kernel = new UiKernel({}, { errorBudget: { community: 1 } });
    const failures = await observer(kernel);
    await kernel.install(plugin('1.0.0'));
    const oldEntry = kernel.slots.get('views', 'versioned')!;
    let reject!: (error: Error) => void;
    runSlotCallback(kernel, 'views', oldEntry, () => new Promise((_, fail) => { reject = fail; }));
    await kernel.install(plugin('2.0.0'));
    reject(new Error('old asynchronous callback failed'));
    await waitFor(() => expect(failures).toHaveBeenCalledWith({ id: ID, version: '1.0.0', error: 'report: old asynchronous callback failed' }));
    expect(kernel.errors.count(ID)).toBe(0);
    expect(kernel.plugins().find(item => item.id === ID)?.meta.version).toBe('2.0.0');
    expect(kernel.errors.list(ID)).toMatchObject([{ version: '1.0.0', message: 'old asynchronous callback failed' }]);

    // Current-release failure still reaches recovery with its identity even after the budget unloads it.
    runSlotCallback(kernel, 'views', kernel.slots.get('views', 'versioned')!, () => { throw new Error('current failed'); });
    expect(failures).toHaveBeenLastCalledWith({ id: ID, version: '2.0.0', error: 'report: current failed' });
    await waitFor(() => expect(kernel.list()).not.toContain(ID));
    await kernel.dispose();
  });

  it('attributes detached render entries to their registering version, and leaves unknown versions unknown', async () => {
    const kernel = new UiKernel({}, { errorBudget: { community: 1 } });
    const failures = await observer(kernel);
    await kernel.install(plugin('1.0.0'));
    const oldEntry = kernel.slots.get('views', 'versioned')!;
    await kernel.install(plugin('2.0.0'));
    function Boom() { throw new Error('old renderer failed'); return null; }
    const mounted = render(<UiKernelProvider kernel={kernel}>
      <SlotEntryScope slot="views" entry={oldEntry} fallback={<span>failed</span>}><Boom /></SlotEntryScope>
    </UiKernelProvider>);
    expect(mounted.getByText('failed')).toBeTruthy();
    expect(failures).toHaveBeenCalledWith({ id: ID, version: '1.0.0', error: 'render: old renderer failed' });

    const legacy: SlotEntry<null> = { owner: ID, origin: 'community', id: 'legacy', order: 0, value: null };
    runSlotCallback(kernel, 'views', legacy, () => { throw new Error('unknown source'); });
    expect(failures).toHaveBeenLastCalledWith({ id: ID, version: undefined, error: 'report: unknown source' });
    expect(kernel.errors.count(ID)).toBe(0);
    expect(kernel.plugins().find(item => item.id === ID)?.meta.version).toBe('2.0.0');
    await kernel.dispose();
  });

  it('captures apply/self-report versions from their scope instead of looking up the installed replacement', async () => {
    const kernel = new UiKernel();
    const failures = await observer(kernel);
    await expect(kernel.install(defineUiPlugin({ meta: { id: ID, version: '1.1.0' }, apply() {
      throw new Error('apply failed');
    } }))).rejects.toThrow('apply failed');
    expect(failures).toHaveBeenCalledWith({ id: ID, version: '1.1.0', error: 'report: apply failed' });
    await kernel.install(defineUiPlugin({ meta: { id: ID, version: '2.1.0' }, apply(ctx) {
      ctx.ui.reportError(new Error('scope failed'));
    } }));
    expect(failures).toHaveBeenLastCalledWith({ id: ID, version: '2.1.0', error: 'report: scope failed' });
    await kernel.dispose();
  });

  it('isolates throwing and reentrant observers without skipping recovery or notifying a newly added observer in the same dispatch', () => {
    const exhausted = vi.fn();
    const budget = new UiErrorBudget({ community: 1 }, exhausted);
    const late = vi.fn(), next = vi.fn();
    budget.onReport(() => { budget.onReport(late); throw new Error('observer failed'); });
    budget.onReport(next);
    budget.subscribe(() => { throw new Error('budget observer failed'); });
    const report = () => budget.report({ pluginId: ID, origin: 'community', version: '1.0.0', phase: 'report', error: 'fault' });
    expect(report).not.toThrow();
    expect(exhausted).toHaveBeenCalledWith(ID);
    expect(next).toHaveBeenCalledOnce();
    expect(late).not.toHaveBeenCalled();
    report();
    expect(late).toHaveBeenCalledOnce();
  });
});
