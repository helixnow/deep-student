/**
 * localStorage 迁移的外壳接线（DESIGN.md §8.2）：Host 启动前的准备只给“重试 / 退出”；
 * 首窗先加载空白迁移页，preload 写入并回报、main flush + 标记完成后才加载应用入口。
 */
import { describe, expect, it } from 'vitest';
import { WebviewMigrationError, type PreparedWebviewMigration, type SourceRecord } from '../storage-migration/index.ts';
import {
  WEBVIEW_MIGRATION_APPLIED_CHANNEL,
  WEBVIEW_MIGRATION_PENDING_CHANNEL,
  WEBVIEW_MIGRATION_VERIFIED_CHANNEL,
  type StorageLike,
} from '../storage-migration/apply.ts';
import { applyPendingWebviewMigration } from '../preload/webview-migration.ts';
import {
  prepareWebviewMigrationGate,
  WebviewMigrationApplier,
  type MigrationChoice,
} from '../shell/webview-migration.ts';

const source: SourceRecord = { kind: 'webkit-sqlite', origin: 'tauri://localhost', path: '/src/db', files: ['/src/db'] };
const entries: ReadonlyArray<readonly [string, string]> = [['a', '1'], ['dstu-theme-mode', 'dark'], ['empty', '']];

function scriptedPrompt(choices: MigrationChoice[]) {
  const calls: Array<{ message: string; detail: string }> = [];
  return {
    calls,
    prompt: async (message: string, detail: string) => {
      calls.push({ message, detail });
      const next = choices.shift();
      if (next === undefined) throw new Error('unexpected prompt');
      return next;
    },
  };
}

describe('prepareWebviewMigrationGate (before Host start)', () => {
  it('retries prepare until it succeeds; each failure shows only the userMessage with the technical detail', async () => {
    const prepared: PreparedWebviewMigration = { status: 'pending', entries, source };
    let attempts = 0;
    const { calls, prompt } = scriptedPrompt(['retry', 'retry']);
    const result = await prepareWebviewMigrationGate({
      prepare: async () => {
        attempts += 1;
        if (attempts === 1) throw new WebviewMigrationError('WRITER_RUNNING', 'pid 42');
        if (attempts === 2) throw new WebviewMigrationError('SOURCE_UNREADABLE', 'bad db');
        return prepared;
      },
      prompt,
      log: () => undefined,
    });
    expect(result).toBe(prepared);
    expect(attempts).toBe(3);
    expect(calls).toEqual([
      { message: new WebviewMigrationError('WRITER_RUNNING', '').userMessage, detail: '[webview-migration] WRITER_RUNNING: pid 42' },
      { message: new WebviewMigrationError('SOURCE_UNREADABLE', '').userMessage, detail: '[webview-migration] SOURCE_UNREADABLE: bad db' },
    ]);
  });

  it('exit returns null without calling prepare again (caller must not open a window)', async () => {
    let attempts = 0;
    const logs: string[] = [];
    const { calls, prompt } = scriptedPrompt(['exit']);
    const result = await prepareWebviewMigrationGate({
      prepare: async () => { attempts += 1; throw new WebviewMigrationError('SNAPSHOT_FAILED', 'ENOSPC'); },
      prompt,
      log: (message) => logs.push(message),
    });
    expect(result).toBeNull();
    expect(attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(logs.some((line) => line.includes('SNAPSHOT_FAILED') && line.includes('ENOSPC'))).toBe(true);
  });

  it('an unexpected error is still a retry/exit decision, never a silent skip', async () => {
    const { calls, prompt } = scriptedPrompt(['exit']);
    const result = await prepareWebviewMigrationGate({ prepare: async () => { throw new TypeError('boom'); }, prompt, log: () => undefined });
    expect(result).toBeNull();
    expect(calls[0]?.detail).toContain('boom');
    expect(calls[0]?.message).not.toBe('');
  });
});

function harness(
  choices: MigrationChoice[],
  overrides: { flush?: () => Promise<void>; complete?: () => void; confirmPersisted?: (expected: ReadonlyMap<string, string>) => Promise<void> } = {},
) {
  const events: string[] = [];
  const { calls, prompt } = scriptedPrompt(choices);
  const applier = new WebviewMigrationApplier({
    entries,
    prompt,
    flush: overrides.flush ?? (async () => { events.push('flush'); }),
    confirmPersisted: async (expected) => {
      events.push(`confirm:${JSON.stringify([...expected])}`);
      await overrides.confirmPersisted?.(expected);
    },
    complete: (report) => {
      events.push(`complete:${report.written}/${report.kept}`);
      overrides.complete?.();
    },
    loadMigrationPage: () => events.push('load-migration-page'),
    loadApp: () => events.push('load-app'),
    exit: () => events.push('exit'),
    log: () => undefined,
  });
  return { applier, events, prompts: calls };
}

/** 目标原有 `dstu-theme-mode=light`（target wins），其余两个键写入快照值。 */
const appliedReport = { written: 2, kept: 1, keptKeys: ['dstu-theme-mode'], failed: [] };
const readBack = { values: ['1', 'light', ''] };
const persisted = JSON.stringify([['a', '1'], ['dstu-theme-mode', 'light'], ['empty', '']]);

/** 写入页：领取、回报、加载结束。 */
async function applyPage(applier: WebviewMigrationApplier, report: unknown = appliedReport): Promise<void> {
  applier.pending(true);
  applier.applied(true, report);
  await applier.idle();
  applier.pageLoaded(true);
  await applier.idle();
}

/** 核对页：领取待核对的键、回报读回的值、加载结束。 */
async function verifyPage(applier: WebviewMigrationApplier, report: unknown = readBack): Promise<unknown> {
  const request = JSON.parse(applier.pending(true)) as unknown;
  applier.verified(true, report);
  await applier.idle();
  applier.pageLoaded(true);
  await applier.idle();
  return request;
}

describe('WebviewMigrationApplier (first window)', () => {
  it('hands the entries only to the migration page, once per load', () => {
    const { applier } = harness([]);
    applier.start();
    expect(applier.pending(false)).toBe('null');
    expect(JSON.parse(applier.pending(true))).toEqual(entries);
    expect(applier.pending(true)).toBe('null');
  });

  it('success: write, flush, reload and read every key back, confirm on disk, then mark done and load the app', async () => {
    const { applier, events } = harness([]);
    applier.start();
    await applyPage(applier);
    expect(events).toEqual(['load-migration-page', 'flush', 'load-migration-page']);
    expect(applier.state).toBe('verifying');
    expect(await verifyPage(applier)).toEqual({ verify: ['a', 'dstu-theme-mode', 'empty'] });
    expect(events).toEqual(['load-migration-page', 'flush', 'load-migration-page', `confirm:${persisted}`, 'complete:2/1', 'load-app']);
    expect(applier.state).toBe('done');
    expect(applier.pending(true)).toBe('null');
  });

  it('the verification reload waits for the write page to finish loading (its late did-finish-load is not the verify page)', async () => {
    const { applier, events, prompts } = harness([]);
    applier.start();
    applier.pending(true);
    applier.applied(true, appliedReport);
    await applier.idle();
    expect(events).toEqual(['load-migration-page', 'flush']);
    applier.pageLoaded(true);
    await applier.idle();
    expect(events).toEqual(['load-migration-page', 'flush', 'load-migration-page']);
    expect(prompts).toHaveLength(0);
  });

  it('a written key that reads back different from the snapshot, or a kept key that vanished, is a failure; nothing is marked done', async () => {
    for (const values of [['1', 'light', 'changed'], ['1', null, ''], ['1', 'light']]) {
      const { applier, events, prompts } = harness(['exit']);
      applier.start();
      await applyPage(applier);
      await verifyPage(applier, { values });
      expect(prompts.map((call) => call.message)).toEqual([new WebviewMigrationError('TARGET_VERIFY_FAILED', '').userMessage]);
      expect(events.some((event) => event.startsWith('confirm') || event.startsWith('complete') || event === 'load-app')).toBe(false);
      expect(events.at(-1)).toBe('exit');
    }
  });

  it('a verify page that loads without reading back, or a failed disk confirmation, is a failure; retry starts over with the write page', async () => {
    const silent = harness(['exit']);
    silent.applier.start();
    await applyPage(silent.applier);
    silent.applier.pending(true);
    silent.applier.pageLoaded(true);
    await silent.applier.idle();
    expect(silent.prompts[0]?.detail).toContain('没有回报核对结果');

    let confirms = 0;
    const disk = harness(['retry'], {
      confirmPersisted: async () => {
        confirms += 1;
        if (confirms === 1) throw new WebviewMigrationError('TARGET_VERIFY_FAILED', 'leveldb still missing a');
      },
    });
    disk.applier.start();
    await applyPage(disk.applier);
    await verifyPage(disk.applier);
    expect(disk.prompts[0]?.detail).toContain('leveldb still missing a');
    expect(disk.events.filter((event) => event.startsWith('complete'))).toEqual([]);
    // 重试：重新写入（全部已存在 → 全部 kept），再核对一次。
    expect(JSON.parse(disk.applier.pending(true))).toEqual(entries);
    disk.applier.applied(true, { written: 0, kept: 3, keptKeys: ['a', 'dstu-theme-mode', 'empty'], failed: [] });
    await disk.applier.idle();
    disk.applier.pageLoaded(true);
    await disk.applier.idle();
    await verifyPage(disk.applier);
    expect(disk.events.slice(-2)).toEqual(['complete:0/3', 'load-app']);
  });

  it('a failed key blocks the app; retry reloads the migration page and re-delivers the entries', async () => {
    const { applier, events, prompts } = harness(['retry']);
    applier.start();
    applier.pending(true);
    applier.applied(true, { written: 1, kept: 0, keptKeys: [], failed: [{ key: 'a', error: 'QuotaExceededError: full' }] });
    await applier.idle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.detail).toContain('QuotaExceededError');
    // 重新加载要等上一次加载结束，否则它迟到的 did-finish-load 会被当成新页面“没有回报”。
    expect(events).toEqual(['load-migration-page']);
    applier.pageLoaded(true);
    await applier.idle();
    expect(events).toEqual(['load-migration-page', 'load-migration-page']);
    expect(prompts).toHaveLength(1);
    expect(JSON.parse(applier.pending(true))).toEqual(entries);
    applier.applied(true, { written: 0, kept: 3, keptKeys: ['a', 'dstu-theme-mode', 'empty'], failed: [] });
    await applier.idle();
    applier.pageLoaded(true);
    await applier.idle();
    await verifyPage(applier);
    expect(events.slice(1)).toEqual(['load-migration-page', 'flush', 'load-migration-page', `confirm:${persisted}`, 'complete:0/3', 'load-app']);
  });

  it('exit after a failure never loads the app', async () => {
    const { applier, events } = harness(['exit']);
    applier.start();
    applier.pending(true);
    applier.applied(true, { written: 0, kept: 0, keptKeys: [], failed: [{ key: 'a', error: 'x' }] });
    await applier.idle();
    expect(events).toEqual(['load-migration-page', 'exit']);
    expect(applier.state).toBe('exited');
    expect(applier.pending(true)).toBe('null');
  });

  it('a migration page that finished loading without a report counts as a failure (preload crashed or never ran)', async () => {
    const { applier, events, prompts } = harness(['exit']);
    applier.start();
    applier.pageLoaded(false);
    await applier.idle();
    expect(prompts).toHaveLength(0);
    applier.pageLoaded(true);
    await applier.idle();
    expect(prompts).toHaveLength(1);
    expect(events).toEqual(['load-migration-page', 'exit']);
  });

  it('flush or completion failures are failures too, and a malformed report is rejected', async () => {
    const flushFails = harness(['exit'], { flush: async () => { throw new Error('flush failed'); } });
    flushFails.applier.start();
    flushFails.applier.pending(true);
    flushFails.applier.applied(true, appliedReport);
    await flushFails.applier.idle();
    flushFails.applier.pageLoaded(true);
    await flushFails.applier.idle();
    expect(flushFails.prompts[0]?.detail).toContain('flush failed');
    expect(flushFails.events).not.toContain('load-app');

    const completeFails = harness(['exit'], { complete: () => { throw new WebviewMigrationError('NOT_SNAPSHOTTED', 'state done'); } });
    completeFails.applier.start();
    await applyPage(completeFails.applier);
    await verifyPage(completeFails.applier);
    expect(completeFails.prompts[0]?.message).toBe(new WebviewMigrationError('NOT_SNAPSHOTTED', '').userMessage);
    expect(completeFails.events).not.toContain('load-app');

    for (const report of [{ written: '1' }, { written: 2, kept: 1, failed: [] }, { written: 2, kept: 1, keptKeys: ['not-an-entry'], failed: [] }]) {
      const malformed = harness(['exit']);
      malformed.applier.start();
      malformed.applier.pending(true);
      malformed.applier.applied(true, report);
      await malformed.applier.idle();
      expect(malformed.prompts).toHaveLength(1);
      expect(malformed.events).toEqual(['load-migration-page', 'exit']);
    }
  });

  it('reports from other documents are ignored', async () => {
    const { applier, events, prompts } = harness([]);
    applier.start();
    applier.applied(false, { written: 9, kept: 0, failed: [] });
    await applier.idle();
    expect(events).toEqual(['load-migration-page']);
    expect(prompts).toHaveLength(0);
  });
});

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}

describe('applyPendingWebviewMigration (preload)', () => {
  it('does nothing — not even touching localStorage — when main has nothing pending', () => {
    const sent: unknown[][] = [];
    applyPendingWebviewMigration({ sendSync: (...args: unknown[]) => { sent.push(args); return 'null'; } }, () => { throw new Error('must not touch storage'); });
    expect(sent).toEqual([[WEBVIEW_MIGRATION_PENDING_CHANNEL]]);
  });

  it('writes with target wins and reports back synchronously', () => {
    const storage = new MemoryStorage();
    storage.setItem('dstu-theme-mode', 'light');
    const sent: unknown[][] = [];
    applyPendingWebviewMigration({
      sendSync: (...args: unknown[]) => {
        sent.push(args);
        return args[0] === WEBVIEW_MIGRATION_PENDING_CHANNEL ? JSON.stringify(entries) : null;
      },
    }, () => storage);
    expect(storage.getItem('dstu-theme-mode')).toBe('light');
    expect(storage.getItem('a')).toBe('1');
    expect(storage.getItem('empty')).toBe('');
    expect(sent[1]).toEqual([WEBVIEW_MIGRATION_APPLIED_CHANNEL, { written: 2, kept: 1, keptKeys: ['dstu-theme-mode'], failed: [] }]);
  });

  it('verify mode only reads the requested keys back (missing keys as null) and never writes', () => {
    const storage = new MemoryStorage();
    storage.setItem('a', '1');
    storage.setItem('dstu-theme-mode', 'light');
    const writes: string[] = [];
    const sent: unknown[][] = [];
    applyPendingWebviewMigration({
      sendSync: (...args: unknown[]) => {
        sent.push(args);
        return args[0] === WEBVIEW_MIGRATION_PENDING_CHANNEL ? JSON.stringify({ verify: ['a', 'dstu-theme-mode', 'empty'] }) : null;
      },
    }, () => ({ getItem: (key) => storage.getItem(key), setItem: (key) => { writes.push(key); } }));
    expect(writes).toEqual([]);
    expect(sent[1]).toEqual([WEBVIEW_MIGRATION_VERIFIED_CHANNEL, { values: ['1', 'light', null] }]);
  });

  it('verify mode reports an unreadable storage instead of claiming the keys are there', () => {
    const sent: unknown[][] = [];
    applyPendingWebviewMigration({
      sendSync: (...args: unknown[]) => {
        sent.push(args);
        return args[0] === WEBVIEW_MIGRATION_PENDING_CHANNEL ? JSON.stringify({ verify: ['a'] }) : null;
      },
    }, () => { throw new Error('SecurityError: denied'); });
    expect(sent[1]?.[0]).toBe(WEBVIEW_MIGRATION_VERIFIED_CHANNEL);
    expect(String((sent[1]?.[1] as { error: string }).error)).toContain('SecurityError');
  });

  it('a storage that cannot be opened is reported as a failure instead of being skipped', () => {
    const sent: unknown[][] = [];
    applyPendingWebviewMigration({
      sendSync: (...args: unknown[]) => {
        sent.push(args);
        return args[0] === WEBVIEW_MIGRATION_PENDING_CHANNEL ? JSON.stringify(entries) : null;
      },
    }, () => { throw new Error('SecurityError: denied'); });
    const report = sent[1]?.[1] as { written: number; failed: Array<{ key: string; error: string }> };
    expect(report.written).toBe(0);
    expect(report.failed).toHaveLength(entries.length);
    expect(report.failed[0]?.error).toContain('SecurityError');
  });
});
