import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { AgentToolExecutor } from '../../agent-skills/api.ts';
import browser from '../index.ts';

describe('browser lane executor registration', () => {
  it('registers BrowserToolExecutor and IndexWebpageToolExecutor through agentTools', async () => {
    const registered: AgentToolExecutor[] = [];
    const settingsValues = new Map<string, string>();
    const settings = {
      get: (key: string) => settingsValues.get(key) ?? null,
      save: (key: string, value: string) => { settingsValues.set(key, value); },
      delete: (key: string) => settingsValues.delete(key),
      listByPrefix: () => [],
      deleteByPrefix: () => 0,
      getSecret: async () => null,
      saveSecret: async () => undefined,
      deleteSecret: async () => false,
    };
    const host = await createTestHost({
      plugins: [browser],
      provide: {
        settings,
        log: { logger: () => undefined },
        storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } },
        featureFlags: {
          load: () => { throw new Error('feature flags are not read during registration'); },
          save: () => undefined,
        },
        agentTools: {
          registerToolExecutors(executors: readonly AgentToolExecutor[]) {
            registered.push(...executors);
          },
        },
      },
      app: { version: '0.11.0', debug: true },
    });
    try {
      expect(registered.map(executor => executor.name())).toEqual([
        'BrowserToolExecutor', 'IndexWebpageToolExecutor',
      ]);
      for (const executor of registered) {
        expect(typeof executor.execute).toBe('function');
      }
      const browserExecutor = registered[0]!;
      expect(browserExecutor.canHandle('builtin-browser_open')).toBe(true);
      expect(browserExecutor.canHandle('builtin-web_fetch')).toBe(false);
      expect(browserExecutor.sensitivityLevel?.('browser_file_upload')).toBe('high');
      const indexExecutor = registered[1]!;
      expect(indexExecutor.canHandle('builtin-index_rebuild')).toBe(true);
      expect(indexExecutor.sensitivityLevel?.('index_rebuild')).toBe('high');
      expect(indexExecutor.concurrencyClass?.('index_status')).toBe('read_only');
    } finally {
      await host.dispose();
    }
  });
});
