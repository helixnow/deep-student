import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationCoordinator } from '../migration/coordinator.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('coordinator smoke', () => {
  it('fresh run_all migrates all four databases, second run applies nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-coord-'));
    dirs.push(dir);
    const logs: string[] = [];
    const c = new MigrationCoordinator({ appDataDir: dir, log: (l, m) => { if (l === 'error' || l === 'warn') logs.push(`${l}: ${m}`); } });
    const r1 = await c.runAll();
    expect(r1.error, logs.join('\n')).toBeNull();
    expect(r1.success).toBe(true);
    expect(r1.databases.map((d) => [d.id, d.toVersion === c.sets[d.id].latestVersion()])).toEqual([
      ['vfs', true], ['llm_usage', true], ['chat_v2', true], ['mistakes', true],
    ]);
    const r2 = await new MigrationCoordinator({ appDataDir: dir }).runAll();
    expect(r2.success).toBe(true);
    expect(r2.databases.every((d) => d.appliedCount === 0)).toBe(true);
  });
});
