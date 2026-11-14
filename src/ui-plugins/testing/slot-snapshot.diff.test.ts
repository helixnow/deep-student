// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { diffSnapshots as diffJsonSnapshots } from '../../../scripts/plugins/slot-owner-moves.mjs';
import { defineUiPlugin, UiKernel } from '../../ui-kernel/kernel';
import { captureSlotSnapshot, diffSlotSnapshots, SLOT_SCENARIOS } from './slot-snapshot';

const scenario = SLOT_SCENARIOS['desktop-prod-normal-uilab-off']!;

async function snapshot(owner: string, labelKey = 'a:b', order = 10) {
  const kernel = new UiKernel();
  await kernel.install(defineUiPlugin({
    meta: { id: owner },
    apply(ctx) {
      ctx.ui.nav.register({ id: 'stats', viewId: 'stats', labelKey, order });
    },
  }), { origin: 'builtin' });
  try {
    return captureSlotSnapshot(kernel, scenario);
  } finally {
    await kernel.dispose();
  }
}

describe('diffSlotSnapshots', () => {
  it('accepts an owner change only when owner-moves.json lists it', async () => {
    const before = await snapshot('dstu.ui.shell');
    const after = await snapshot('dstu.review');
    expect(diffSlotSnapshots(before, after).failures).toContain('nav/stats: owner dstu.ui.shell → dstu.review (not in owner-moves.json)');
    const accepted = diffSlotSnapshots(before, after, [{ slot: 'nav', id: 'stats', from: 'dstu.ui.shell', to: 'dstu.review' }]);
    expect(accepted).toEqual({ failures: [], acceptedMoves: ['nav/stats: dstu.ui.shell → dstu.review'] });
  });

  it('accepts a slot-wide move only from the listed owner', async () => {
    const before = await snapshot('dstu.ui.shell');
    const after = await snapshot('dstu.review');
    expect(diffSlotSnapshots(before, after, [{ slot: 'nav', id: '*', from: 'dstu.ui.shell', to: 'dstu.review' }]).failures).toEqual([]);
    expect(diffSlotSnapshots(before, after, [{ slot: 'nav', id: '*', from: 'dstu.ui.other', to: 'dstu.review' }]).failures)
      .toContain('nav/stats: owner dstu.ui.shell → dstu.review (not in owner-moves.json)');
  });

  it('accepts a new entry only when listed by id with its owner', async () => {
    const before = { ...(await snapshot('dstu.ui.shell')), slots: { nav: { cardinality: 'list', entries: [] } } };
    const after = await snapshot('dstu.ui.shell');
    after.slots = { nav: after.slots.nav! };
    expect(diffSlotSnapshots(before, after).failures).toContain('slot nav: added stats');
    expect(diffSlotSnapshots(before, after, [{ slot: 'nav', id: '*', from: null, to: 'dstu.ui.shell' }]).failures).toContain('slot nav: added stats');
    expect(diffSlotSnapshots(before, after, [{ slot: 'nav', id: 'stats', from: null, to: 'dstu.review' }]).failures).toContain('slot nav: added stats');
    const accepted = diffSlotSnapshots(before, after, [{ slot: 'nav', id: 'stats', from: null, to: 'dstu.ui.shell' }]);
    expect(accepted.acceptedMoves).toEqual(['nav/stats: added by dstu.ui.shell']);
  });

  it('still fails on any other change that accompanies a listed move', async () => {
    const before = await snapshot('dstu.ui.shell');
    const after = await snapshot('dstu.review', 'a:c', 20);
    const { failures } = diffSlotSnapshots(before, after, [{ slot: 'nav', id: 'stats', from: 'dstu.ui.shell', to: 'dstu.review' }]);
    expect(failures).toEqual(expect.arrayContaining(['nav/stats: order 10 → 20', 'nav/stats: value.labelKey: "a:b" → "a:c"']));
  });

  it('agrees with the standalone W39 before/after tool', async () => {
    const move = { slot: 'nav', id: 'stats', from: 'dstu.ui.shell', to: 'dstu.review' };
    const shell = await snapshot('dstu.ui.shell');
    const review = await snapshot('dstu.review');
    const changed = await snapshot('dstu.review', 'a:c', 20);
    const cases: [string, typeof shell, typeof shell, (typeof move)[]][] = [
      ['identical', shell, shell, []],
      ['listed owner move', shell, review, [move]],
      ['unlisted owner move', shell, review, []],
      ['listed move with other drift', shell, changed, [move]],
    ];
    for (const [label, before, after, moves] of cases) {
      const standalone = diffJsonSnapshots(before, after, moves);
      const inRepo = diffSlotSnapshots(before, after, moves);
      expect(standalone.failures.length === 0, label).toBe(inRepo.failures.length === 0);
      expect(standalone.acceptedMoves, label).toEqual(inRepo.acceptedMoves);
    }
  });
});
