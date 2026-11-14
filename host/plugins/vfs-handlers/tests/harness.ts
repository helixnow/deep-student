/** Shared host for L13b command tests: real VFS schema, L10/L11/L13 services. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import type { TestPluginEntry } from '../../../kernel/testing.ts';
import type { RawPromptLlm } from '../src/llm-needs.ts';
import vfsPlugin from '../../vfs/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import vfsIndexPlugin from '../../vfs-index/index.ts';
import mediaPlugin from '../../media/index.ts';
import plugin from '../index.ts';

export interface VfsHost {
  host: TestHost;
  storage: ReturnType<typeof createStorageService>;
  root: string;
  dispose(): Promise<void>;
}

let templatePromise: Promise<string> | undefined;

/** One migrated database image is reused by every test (matching L13's own test setup). */
async function schemaTemplate(): Promise<string> {
  templatePromise ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'l13b-schema-'));
    const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
    try {
      const report = await storage.migrations.runAll();
      expect(report.success, JSON.stringify(report)).toBe(true);
    } finally {
      storage.dispose();
    }
    return dir;
  })();
  return templatePromise;
}

export async function createVfsHost(options: {
  plugins?: readonly TestPluginEntry[];
  llm?: RawPromptLlm;
  provide?: Record<string, unknown>;
  shell?: (op: string, args: unknown) => unknown;
} = {}): Promise<VfsHost> {
  const root = mkdtempSync(join(tmpdir(), 'l13b-vfs-'));
  cpSync(await schemaTemplate(), root, { recursive: true });
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  // Real F4 settings service; only the secure store is absent in tests.
  const settings = createSettingsService({
    db: () => storage.database('mistakes'),
    secureStore: () => null,
    secrets: { isSensitiveKey: () => false },
  });
  const paths = createPaths({ dataDir: root, platform: process.platform as 'linux' | 'darwin' | 'win32',
    env: { HOME: root, USERPROFILE: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, DEVICE_ID: 'l13b-test-device' } });
  const files = createNodeFiles({ roots: [{ name: 'appData', path: root }] });
  const provide: Record<string, unknown> = { storage, settings, paths, files, ...(options.provide ?? {}) };
  if (options.llm !== undefined) provide.llm = options.llm;
  const host = await createTestHost({
    plugins: [vfsReposPlugin, notesPlugin, vfsIndexPlugin, vfsPlugin, mediaPlugin, plugin, ...(options.plugins ?? [])],
    provide,
    app: { dataDir: root },
    ...(options.shell ? { shell: options.shell } : {}),
  });
  return {
    host,
    storage,
    root,
    async dispose() {
      await host.dispose();
      storage.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
