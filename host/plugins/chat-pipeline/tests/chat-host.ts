import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHost } from '../../../kernel/testing.ts';
import { definePlugin } from '../../../kernel/api.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { importProfile, resolveProfile } from '../../../kernel/profile.ts';
import { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { InjectionBudgetManager, defaultBudgetConfig, newInjectionItem } from '../../../platform/storage/injection-budget.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import native from '../../../platform/native/index.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import diagnostics from '../../../platform/diagnostics/index.ts';
import pipeline from '../index.ts';


/** Real migrated chat DB, optionally with the real VFS and blob repository. */
export async function createPipelineHost(options: { vfs?: boolean; llm?: boolean; diagnostics?: boolean; appVersion?: string; tempRoot?: string; provide?: Record<string, unknown>;
  setupStorage?: (storage: StorageServiceImpl) => void } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(options.tempRoot ?? tmpdir(), 'pipeline-chat-')));
  const platform = process.platform;
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`Unsupported desktop test platform: ${platform}`);
  }
  const storage = new StorageServiceImpl({ baseDir: root, dataLocalDir: root });
  const coordinator = new MigrationCoordinator({ appDataDir: storage.locations.activeDir, auditDbPath: null });
  const migration = coordinator.migrateSingle('chat_v2');
  if (!migration.success) throw new Error(JSON.stringify(migration));
  const mainMigration = coordinator.migrateSingle('mistakes');
  if (!mainMigration.success) throw new Error(JSON.stringify(mainMigration));
  if (options.vfs || options.llm) {
    const vfsMigration = coordinator.migrateSingle('vfs');
    if (!vfsMigration.success) throw new Error(JSON.stringify(vfsMigration));
  }
  const settings = createSettingsStore({ db: () => storage.database('mistakes'),
    secureStore: () => null, isSensitiveKey: () => false });
  options.setupStorage?.(storage);
  // Install L04 through the host profile loader; consume only its public service.
  const entries = await resolveProfile(fileURLToPath(new URL('./fixtures/finalization.profile.json', import.meta.url)));
  const loaded = await importProfile(entries.filter(entry => {
    if (entry.id === 'dstu.llm' || entry.id === 'dstu.llm-providers') return options.llm === true;
    // dstu.vfs injects vfsIndex since L13 cb61f6ce6; the index plugin travels with dstu.vfs.
    if (entry.id === 'dstu.vfs-index') return options.vfs === true || options.llm === true;
    return options.vfs || (entry.id !== 'dstu.media' && (entry.id !== 'dstu.vfs' || options.llm));
  }));
  if (!loaded.some(entry => entry.plugin.meta.id === 'dstu.chat')) {
    throw new Error('Finalization fixture does not publish dstu.chat');
  }
  const host = await createTestHost({
    app: { dataDir: root, ...(options.appVersion ? { version: options.appVersion } : {}) },
    provide: { files: createNodeFiles({ roots: [{ name: 'appData', path: root }, { name: 'temp', path: tmpdir() }] }),
      ...options.provide, storage, settings,
      injectionBudget: { defaultConfig: defaultBudgetConfig, createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config), newItem: newInjectionItem },
      paths: createPaths({ dataDir: root, platform }), notes: {}, ...((options.vfs || options.llm) ? {} : { vfs: { version: 1, database: { getConnSafe(): never {
      throw new Error('VFS is not used by the pipeline finalizer fixture');
    } } } }) },
    plugins: [native, ...(options.llm ? [definePlugin({
      meta: { id: 'test.pipeline-secrets', provides: ['secrets'] },
      apply(ctx) {
        ctx.provide('secrets', createSecretsService({ keystore: null,
          os: { home: root, data: root, dataLocal: root, config: root, cache: root, temp: root, download: root },
          log: { target: 'pipeline-test', debug: m => ctx.logger.debug(m), info: m => ctx.logger.info(m),
            warn: m => ctx.logger.warn(m), error: m => ctx.logger.error(m), trace: m => ctx.logger.debug(m) },
        }));
      },
    })] : []), ...loaded.map(entry => entry.plugin), pipeline, ...(options.diagnostics ? [diagnostics] : [])],
  });
  return { ctx: host.ctx, runtime: host.runtime, events: host.events, invoke: host.invoke, install: host.install, async dispose() {
    await host.dispose();
    storage.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  } };
}
