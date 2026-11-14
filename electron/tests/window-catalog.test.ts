import { expect, it } from 'vitest';
import { createTestHost } from '../../host/kernel/testing.ts';
import plugin from '../index.ts';

it('the public shellWindows service preserves empty/no-main snapshots and uses live queries', async () => {
  const h = await createTestHost({ plugins: [plugin], shell: (op) => op === 'window.listWindows' ? [] : null });
  try {
    expect(await h.ctx.shellWindows.listWindows()).toEqual([]);
    expect(await h.ctx.shellWindows.getMainWindow()).toBeNull();
    expect(await h.ctx.shellWindows.listWindows()).toEqual([]);
    expect(h.shellRequests.map(({ op }) => op)).toEqual(['window.listWindows', 'window.getMainWindow', 'window.listWindows']);
  } finally { await h.dispose(); }
});

it('the public shellWindows service rejects malformed replies instead of treating them as no windows', async () => {
  const h = await createTestHost({ plugins: [plugin], shell: (op) => op === 'window.listWindows' ? [{ label: 'main', isMain: true, focused: 'yes' }] : { label: 'main' } });
  try {
    await expect(h.ctx.shellWindows.listWindows()).rejects.toThrow('invalid shell window snapshot');
    await expect(h.ctx.shellWindows.getMainWindow()).rejects.toThrow('invalid shell window snapshot');
  } finally { await h.dispose(); }
});

it('the public shellWindows service propagates unavailable-shell failures', async () => {
  const h = await createTestHost({ plugins: [plugin], shell: () => { throw new Error('main unavailable'); } });
  try {
    await expect(h.ctx.shellWindows.listWindows()).rejects.toThrow('main unavailable');
    await expect(h.ctx.shellWindows.getMainWindow()).rejects.toThrow('main unavailable');
  } finally { await h.dispose(); }
});
