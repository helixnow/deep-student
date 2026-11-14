/**
 * 手写分派基线（只减不增）。重录：
 *   DS_RESOURCE_TYPES_UPDATE=update vitest run src/shared/resource-types/__tests__/dispatchInventory.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanDispatch, summarize, type DispatchBaseline } from '../inventory';

const UPDATE = process.env.DS_RESOURCE_TYPES_UPDATE === 'update';
const BASELINE = path.resolve('src/shared/resource-types/__golden__/dispatch-baseline.json');

describe('resource type dispatch inventory', () => {
  it('has no hand-written dispatch beyond the recorded baseline', () => {
    const actual = scanDispatch();
    if (UPDATE) {
      fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
      fs.writeFileSync(BASELINE, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as DispatchBaseline;
    const failures: string[] = [];
    for (const [file, counts] of Object.entries(actual)) {
      const allowed = baseline[file] ?? { switch: 0, map: 0 };
      if (counts.switch + counts.map > allowed.switch + allowed.map) {
        failures.push(`${file}: dispatch ${allowed.switch + allowed.map}→${counts.switch + counts.map}`);
      }
    }
    expect(failures, 'new hand-written resource-type dispatch; use resource-types/lookup.ts instead').toEqual([]);
  });

  it('records the W37 starting point', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as DispatchBaseline;
    const summary = summarize(baseline);
    // 任务书基线「26 文件 / 132 处」的 26 文件 = 含资源类型映射表的文件；switch 另计 20 处 / 15 文件。
    expect(summary.mapFiles).toBe(26);
    expect(summary.switchFiles).toBe(15);
    expect(summary.switches).toBe(20);
    expect(summary.maps).toBe(39);
    expect(summary.files).toBe(39);
  });
});
