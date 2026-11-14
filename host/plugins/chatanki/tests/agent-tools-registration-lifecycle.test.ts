// V01-07: the `agentTools` registration is scoped to chatanki and to the provider that received it.
// Real L07 (agent-skills) registry; chatanki's own owner services are stubs because only the
// registration lifecycle is under test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentSkillsPlugin from '../../agent-skills/index.ts';
import chatanki from '../index.ts';

const OWN = ['FsrsSettingsExecutor', 'TemplateDesignerExecutor', 'ChatAnkiToolExecutor'];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(toolingFirst: boolean): Promise<TestHost> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-agent-tools-lifecycle-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  cleanups.push(() => storage.dispose());
  const host = await createTestHost({
    app: { dataDir: dir },
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      review: {}, llm: {}, anki: {},
    },
  });
  cleanups.push(() => host.dispose());
  if (toolingFirst) await host.install(agentSkillsPlugin);
  await host.install(chatanki);
  if (!toolingFirst) await host.install(agentSkillsPlugin);
  return host;
}

function chatankiEntries(host: TestHost): string[] {
  return host.ctx.agentTools.toolExecutors().map((executor) => executor.name()).filter((name) => OWN.includes(name));
}

it('V01-07: unloading chatanki withdraws its executors from an existing agentTools registry', async () => {
  const host = await setup(true);
  expect(chatankiEntries(host)).toEqual(OWN);
  await host.unload('dstu.chatanki');
  expect(chatankiEntries(host)).toEqual([]);
  expect(host.ctx.agentTools.toolExecutors().length).toBeGreaterThan(0);
});

it('V01-07: a replaced agentTools provider gets exactly one chatanki registration, withdrawn on chatanki unload', async () => {
  const host = await setup(false);
  expect(chatankiEntries(host)).toEqual(OWN);
  await host.unload('dstu.agent-skills');
  await host.install(agentSkillsPlugin);
  expect(chatankiEntries(host)).toEqual(OWN);
  await host.unload('dstu.chatanki');
  expect(chatankiEntries(host)).toEqual([]);
});

it('V01-07: reinstalling chatanki registers once more after an unload, never twice', async () => {
  const host = await setup(true);
  await host.unload('dstu.chatanki');
  await host.install(chatanki);
  expect(chatankiEntries(host)).toEqual(OWN);
});
