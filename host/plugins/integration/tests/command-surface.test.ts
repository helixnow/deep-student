import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import integration from '../index.ts';
import audit from '../audit/commands.json' with { type: 'json' };

it('audits every frontend-uncalled command without declaring unapproved dead code', () => {
  expect(audit.uncalledCommands.length).toBeGreaterThan(0);
  expect(audit.uncalledCommands.every((entry) => entry.approvedDead === false)).toBe(true);
});

it('leaves all 50 undefined frontend names absent from the IPC contracts', () => {
  expect(audit.undefinedCommands).toHaveLength(50);
  const directory = new URL('../../../../contracts/ipc/', import.meta.url);
  const registered = new Set<string>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const contract = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
    for (const command of contract.commands ?? []) registered.add(command.name);
  }
  for (const { name } of audit.undefinedCommands) expect(registered.has(name), name).toBe(false);
});

describe('historical undefined frontend calls: app ACL error before dispatch', () => {
  let debug: TestHost;
  let release: TestHost;
  let dir: string;
  let storage: StorageServiceImpl;
  beforeAll(async () => {
    // dstu.integration injects F3 storage (temp_sessions persistence); the real service, no migrations needed.
    dir = mkdtempSync(path.join(tmpdir(), 'l22-command-surface-'));
    storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
    debug = await createTestHost({ plugins: [integration], provide: { storage }, app: { debug: true } });
    release = await createTestHost({ plugins: [integration], provide: { storage }, app: { debug: false } });
  });
  afterAll(async () => {
    await Promise.all([debug?.dispose(), release?.dispose()]);
    storage?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const { name } of audit.undefinedCommands) {
    it(`${name}: debug`, async () => {
      expect(debug.ctx.commands.has(name)).toBe(false);
      await expect(debug.invoke(name, {})).rejects.toBe(`${name} not allowed. Command not found`);
      expect(debug.events).toEqual([]);
    });
    it(`${name}: release`, async () => {
      expect(release.ctx.commands.has(name)).toBe(false);
      await expect(release.invoke(name, {})).rejects.toBe(`Command ${name} not allowed by ACL`);
      expect(release.events).toEqual([]);
    });
  }
});
