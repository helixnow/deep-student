// @vitest-environment node
/**
 * FE-A1 layer 1 golden: tests/visual/__golden__/slots/<scenario>.json.
 * Check mode is the default (also in a plain `vitest run`). Writing requires the explicit
 * `DS_SLOT_SNAPSHOT=update`, normally via `node scripts/plugins/slot-snapshot.mjs --update`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as studyIcons from '@/components/icons/StudySidebarIcons';
import { UiKernel } from '../../ui-kernel/kernel';
import { installOfficialUiPlugins } from '../official/install';
import {
  captureSlotSnapshot, createAdapterRecorder, diffSlotSnapshots, SLOT_SCENARIOS,
  type OwnerMove, type SlotSnapshot,
} from './slot-snapshot';

const goldenDir = path.resolve('tests/visual/__golden__/slots');
const update = process.env.DS_SLOT_SNAPSHOT === 'update';
const componentNames = new Map<unknown, string>(Object.entries(studyIcons).map(([name, value]) => [value, name]));
const moves: OwnerMove[] = fs.existsSync(path.join(goldenDir, 'owner-moves.json'))
  ? JSON.parse(fs.readFileSync(path.join(goldenDir, 'owner-moves.json'), 'utf8'))
  : [];

async function capture(name: string): Promise<SlotSnapshot> {
  const recorder = createAdapterRecorder();
  const kernel = new UiKernel(recorder.adapters);
  try {
    await installOfficialUiPlugins(kernel);
    return captureSlotSnapshot(kernel, SLOT_SCENARIOS[name]!, { componentNames, recorder });
  } finally {
    await kernel.dispose();
  }
}

describe('FE-A1 slot snapshot', () => {
  const report: string[] = [];
  afterAll(() => {
    if (report.length) console.warn(report.join('\n'));
  });

  for (const name of Object.keys(SLOT_SCENARIOS)) {
    it(name, async () => {
      const file = path.join(goldenDir, `${name}.json`);
      const actual = await capture(name);
      // Two captures in one process must agree before anything is compared or written.
      expect(await capture(name)).toEqual(actual);
      if (update) {
        fs.mkdirSync(goldenDir, { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
        return;
      }
      expect(fs.existsSync(file), `missing ${path.relative(process.cwd(), file)}; generate with node scripts/plugins/slot-snapshot.mjs --update`).toBe(true);
      const expected = JSON.parse(fs.readFileSync(file, 'utf8')) as SlotSnapshot;
      const diff = diffSlotSnapshots(expected, actual, moves);
      for (const move of diff.acceptedMoves) report.push(`[slots] ${name}: accepted owner move ${move}`);
      expect(diff.failures, `slot snapshot drift in ${name}`).toEqual([]);
    });
  }

  it('has no stale scenario files', () => {
    if (update || !fs.existsSync(goldenDir)) return;
    const known = new Set([...Object.keys(SLOT_SCENARIOS).map((name) => `${name}.json`), 'owner-moves.json', 'app-assembly.json']);
    expect(fs.readdirSync(goldenDir).filter((file) => !known.has(file))).toEqual([]);
  });
});
