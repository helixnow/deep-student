/** L07已发布的registration disposer合同：真实provider/consumer作用域，不重跑治理工具业务。 */
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createStartupGate } from '../../../../electron/startup-gate.ts';
import agentSkillsPlugin from '../../agent-skills/index.ts';
import backupPlugin from '../index.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

async function setup(toolingFirst: boolean) {
  const host = await createTestHost();
  hosts.push(host);
  const root = host.app.dataDir;
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), LOCALAPPDATA: root,
    APPDATA: join(root, 'config'), XDG_DATA_HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache') };
  const paths = createPaths({ dataDir: root, platform, env });
  const logger = host.ctx.logger('backup-registration');
  const secrets = createSecretsService({ os: paths.os, env, keystore: null, log: {
    target: 'backup-registration', error: logger.error.bind(logger), warn: logger.warn.bind(logger),
    info: logger.info.bind(logger), debug: logger.debug.bind(logger), trace: logger.debug.bind(logger),
  } });
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  host.ctx.effect(() => () => storage.dispose());
  host.ctx.provide('paths', paths);
  host.ctx.provide('storage', storage);
  host.ctx.provide('secrets', secrets);
  host.ctx.provide('settings', createSettingsService({
    db: () => storage.database('mistakes'), secureStore: () => secrets.openStore(root), secrets,
  }));
  const gate = createStartupGate();
  gate.markStartupReady();
  host.ctx.provide('startupGate', gate);
  if (toolingFirst) await host.install(agentSkillsPlugin);
  await host.install(backupPlugin);
  if (!toolingFirst) await host.install(agentSkillsPlugin);
  return host;
}

it('existing real L07 gets one scoped governance registration; unloading backup preserves a later registration of the same object', async () => {
  const host = await setup(true);
  const tools = host.ctx.agentTools;
  const own = tools.toolExecutors().filter(executor => executor.name() === 'DataGovernanceToolExecutor');
  expect(own).toHaveLength(1);
  expect(typeof own[0]!.execute).toBe('function');
  const laterRegistration = tools.registerToolExecutors([own[0]!]);
  const snapshot = tools.toolExecutors();
  expect(snapshot.filter(executor => executor.name() === 'DataGovernanceToolExecutor')).toHaveLength(2);
  await host.unload('dstu.backup');
  expect(tools.toolExecutors().filter(executor => executor.name() === 'DataGovernanceToolExecutor')).toEqual([own[0]]);
  expect(snapshot.filter(executor => executor.name() === 'DataGovernanceToolExecutor')).toHaveLength(2);
  laterRegistration.dispose();
  expect(tools.toolExecutors().filter(executor => executor.name() === 'DataGovernanceToolExecutor')).toEqual([]);
  expect(tools.toolExecutors().some(executor => executor.name() === 'PtcExecutor')).toBe(true);
});

it('late real L07 and provider replacement each keep one governance contribution and dispose it on backup unload', async () => {
  const host = await setup(false);
  const before = host.ctx.agentTools.toolExecutors().filter(executor => executor.name() === 'DataGovernanceToolExecutor');
  expect(before).toHaveLength(1);
  await host.unload('dstu.agent-skills');
  await host.install(agentSkillsPlugin);
  const tools = host.ctx.agentTools;
  const current = tools.toolExecutors().filter(executor => executor.name() === 'DataGovernanceToolExecutor');
  expect(current).toHaveLength(1);
  expect(current[0]).toBe(before[0]);
  expect(before).toHaveLength(1);
  await host.unload('dstu.backup');
  expect(tools.toolExecutors().filter(executor => executor.name() === 'DataGovernanceToolExecutor')).toEqual([]);
  expect(tools.toolExecutors().some(executor => executor.name() === 'PtcExecutor')).toBe(true);
});
