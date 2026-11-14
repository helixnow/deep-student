/**
 * FE-A1 layer 1, production assembly: tests/visual/__golden__/slots/app-assembly.json.
 * The real `createAppUiKernel()` after the chat plugin module is imported (as the app does once chat
 * loads), so late-installed official UI plugins and the chat block/event/mode registries are covered
 * too, with their owners. Same check/update switch as slot-snapshot.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { captureRegistries, captureSlotSnapshot, diffSlotSnapshots, SLOT_SCENARIOS, type OwnerMove, type SlotSnapshot } from './slot-snapshot';

const goldenDir = path.resolve('tests/visual/__golden__/slots');
const file = path.join(goldenDir, 'app-assembly.json');
const update = process.env.DS_SLOT_SNAPSHOT === 'update';
const moves: OwnerMove[] = fs.existsSync(path.join(goldenDir, 'owner-moves.json'))
  ? JSON.parse(fs.readFileSync(path.join(goldenDir, 'owner-moves.json'), 'utf8'))
  : [];
const appKernelModule = Object.values(import.meta.glob('../../ui-kernel/app-kernel.ts'))[0];

async function settle(): Promise<void> {
  // The app hands its kernel to late-loading plugin halves through a dynamic import; let that chain finish.
  await appKernelModule?.();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** One app boot: module state (registries, the published app kernel) is per process, so each capture gets a fresh module graph. */
async function capture(): Promise<SlotSnapshot> {
  vi.resetModules();
  const [{ blockRegistry, eventRegistry, modeRegistry }, , { createAppUiKernel }, studyIcons] = await Promise.all([
    import('@/features/chat/registry'),
    import('@/features/chat/plugins'),
    import('../../ui-kernel/bootstrap'),
    import('@/components/icons/StudySidebarIcons'),
  ]);
  const componentNames = new Map<unknown, string>(Object.entries(studyIcons).map(([name, value]) => [value, name]));
  const kernel = await createAppUiKernel();
  try {
    await settle();
    const snapshot = captureSlotSnapshot(kernel, SLOT_SCENARIOS['desktop-prod-normal-uilab-off']!, { componentNames });
    const registries = captureRegistries({ 'chat.blocks': blockRegistry, 'chat.events': eventRegistry, 'chat.modes': modeRegistry }, { componentNames });
    return { ...snapshot, slots: { ...snapshot.slots, ...registries } };
  } finally {
    await kernel.dispose();
    await settle();
  }
}

describe('FE-A1 slot snapshot (production assembly)', () => {
  const report: string[] = [];
  afterAll(() => {
    if (report.length) console.warn(report.join('\n'));
  });

  it('app-assembly', async () => {
    const actual = await capture();
    expect(await capture()).toEqual(actual);
    if (update) {
      fs.mkdirSync(goldenDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    expect(fs.existsSync(file), `missing ${path.relative(process.cwd(), file)}; generate with node scripts/plugins/slot-snapshot.mjs --update`).toBe(true);
    const diff = diffSlotSnapshots(JSON.parse(fs.readFileSync(file, 'utf8')) as SlotSnapshot, actual, moves);
    for (const move of diff.acceptedMoves) report.push(`[slots] app-assembly: accepted ${move}`);
    expect(diff.failures, 'slot snapshot drift in app-assembly').toEqual([]);
  }, 60_000);
});
