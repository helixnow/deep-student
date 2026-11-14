import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import { dailyLogNoteTitle, linesContainEntry } from '../src/daily-log.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }
function serviceOf(host: MemoryHost['host']): MemoryServiceImpl {
  return host.ctx.memory as unknown as MemoryServiceImpl;
}

interface TreeNode {
  folder: { title: string };
  children: TreeNode[];
  items: { itemType: string; itemId: string }[];
}

function countFolder(tree: TreeNode, title: string): number {
  return (tree.folder.title === title ? 1 : 0)
    + tree.children.reduce((sum, child) => sum + countFolder(child, title), 0);
}

describe('daily log storage', () => {
  it('concurrent_daily_log_appends_replay_after_cas_conflict', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    const date = '2026-07-11';
    expect(service.appendDailyLog(date, 'seed').appended).toBe(true);

    // Interleave a competing append after the first read but before its CAS
    // write; the stale writer must retry and preserve both entries.
    const first = service.appendDailyLog(date, 'concurrent-a', () => {
      const second = service.appendDailyLog(date, 'concurrent-b');
      expect(second.appended).toBe(true);
    });
    expect(first.appended).toBe(true);

    const snapshot = service.dailyLogSnapshot(date);
    expect(snapshot).not.toBeNull();
    expect(linesContainEntry(snapshot!.content, 'seed')).toBe(true);
    expect(linesContainEntry(snapshot!.content, 'concurrent-a')).toBe(true);
    expect(linesContainEntry(snapshot!.content, 'concurrent-b')).toBe(true);
  });

  it('concurrent_first_daily_log_appends_create_one_reserved_structure', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    const date = '2026-07-12';

    const first = service.appendDailyLog(date, 'first-entry-a', () => {
      const second = service.appendDailyLog(date, 'first-entry-b');
      expect(second.appended).toBe(true);
    });
    expect(first.appended).toBe(true);

    const tree = service.getTree() as unknown as TreeNode;
    expect(countFolder(tree, '记忆')).toBe(1);
    expect(countFolder(tree, '学习日志')).toBe(1);

    const logFolder = tree.children.find(child => child.folder.title === '学习日志');
    expect(logFolder).toBeDefined();
    const notes = logFolder!.items.filter(item => item.itemType === 'note')
      .map(item => service.read(item.itemId))
      .filter(note => note !== null && note.title === dailyLogNoteTitle(date));
    expect(notes).toHaveLength(1);

    const snapshot = service.dailyLogSnapshot(date);
    expect(snapshot).not.toBeNull();
    expect(linesContainEntry(snapshot!.content, 'first-entry-a')).toBe(true);
    expect(linesContainEntry(snapshot!.content, 'first-entry-b')).toBe(true);
  });
});
