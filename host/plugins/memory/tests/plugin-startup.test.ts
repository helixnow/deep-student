import { readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { createMigratedMemoryStorage } from './fixtures/migrated-schema.ts';
import type { LogService } from '../../../platform/log/api.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import logPlugin from '../../../platform/log/index.ts';
import memoryPlugin from '../index.ts';
import { QUICK_ASSISTANT_SHOWN_EVENT } from '../src/quick-assistant.ts';
import {
  createIndexDouble, createNotesDouble, createReposDouble, createRetrievalDouble,
  createSettingsDouble,
} from './support.ts';

let storage: StorageServiceImpl | undefined;
let host: TestHost | undefined;
let dir: string | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  storage?.dispose();
  storage = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

interface ShellHarness {
  windows: Set<string>;
  calls: string[];
  shell: (op: string, args: unknown) => unknown;
}

function shellHarness(): ShellHarness {
  const harness: ShellHarness = {
    windows: new Set<string>(),
    calls: [],
    shell: (op, args) => {
      harness.calls.push(op);
      const value = (args ?? {}) as Record<string, unknown>;
      switch (op) {
        case 'plugin:window|get_all_windows': return [...harness.windows];
        case 'plugin:window|create':
          harness.windows.add((value['options'] as Record<string, unknown>)['label'] as string);
          return null;
        case 'plugin:window|is_visible': return false;
        case 'plugin:window|is_focused': return false;
        case 'plugin:window|cursor_position': return { x: 100, y: 100 };
        case 'plugin:window|monitor_from_point':
        case 'plugin:window|primary_monitor':
          return { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } };
        case 'plugin:window|outer_position': return { x: 10, y: 20 };
        case 'plugin:window|inner_size': return { width: 520, height: 420 };
        case 'plugin:window|scale_factor': return 2;
        default: return null;
      }
    },
  };
  return harness;
}

describe('memory plugin startup against the real platform log dependency', () => {
  it('declares log, applies with the real F4 paths/log plugins and serves quick assistant', async () => {
    const fixture = await createMigratedMemoryStorage('memory-real-log-');
    ({ dir, storage } = fixture);
    const { report } = fixture;
    expect(report.success).toBe(true);
    const db = storage.database('vfs');
    const shell = shellHarness();

    // No `log` entry in provide: the plugin must resolve the real F4 service.
    host = await createTestHost({
      plugins: [pathsPlugin, logPlugin, memoryPlugin],
      provide: {
        storage,
        settings: createSettingsDouble(db),
        notes: createNotesDouble(db),
        vfsRepo: createReposDouble(),
        retrieval: createRetrievalDouble(db),
        vfsIndex: createIndexDouble(),
      },
      app: { dataDir: dir, debug: false },
      shell: shell.shell,
    });

    expect(host.plugins.map(entry => entry.id)).toEqual([
      'dstu.platform.paths', 'dstu.platform.log', 'dstu.memory',
    ]);
    const log = host.ctx.get('log') as LogService | undefined;
    expect(log).toBeDefined();
    expect(host.ctx.get('memory')).toBeDefined();

    await host.invoke('memory_write', {
      title: '真实日志依赖', content: '写入时触发未知 mode 的真实 warn 日志', mode: 'unknown-mode',
    });
    const logText = readFileSync(log!.mainLogFile, 'utf8');
    expect(logText).toContain('[WARN][dstu_memory::memory]');
    expect(logText).toContain("Unknown WriteMode 'unknown-mode'");

    await host.invoke('quick_assistant_show');
    expect(shell.calls).toContain('plugin:window|create');
    expect(host.eventsNamed(QUICK_ASSISTANT_SHOWN_EVENT)).toEqual([null]);
  });
});
