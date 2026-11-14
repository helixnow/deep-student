/**
 * V02-01: Rust `TodoSummaryItem` (crates/dstu-vfs/src/vfs/types.rs:1080-1089) has no
 * `skip_serializing_if`, so `due_date`/`due_time` None serialize as `null`. The command result
 * contract requires both keys; a debug host rejects the whole summary when they are dropped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// boundary-allow cross-plugin-impl: the summary reaches the IPC contract check only through vfs-handlers' real command host
import { createVfsHost, type VfsHost } from '../../vfs-handlers/tests/harness.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);

const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) => vfs.host.invoke(name, args) as Promise<T>;

function localDate(offsetDays: number): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

type SummaryItem = Record<string, unknown>;
interface Summary { todayItems: SummaryItem[]; overdueItems: SummaryItem[]; upcomingHighPriority: SummaryItem[] }

describe('V02-01 todo_get_active_summary keeps dueDate/dueTime keys', { timeout: 120_000 }, () => {
  it('V02-01: a today item without a time carries dueTime null through the debug contract check', async () => {
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    await invoke('todo_create_item', { input: { todoListId: list.id, title: 't', priority: 'high', dueDate: localDate(0) } });

    const summary = await invoke<Summary>('todo_get_active_summary');
    expect(summary.todayItems).toHaveLength(1);
    expect(summary.todayItems[0]).toHaveProperty('dueTime', null);
    expect(summary.todayItems[0]).toHaveProperty('dueDate', localDate(0));
    expect(Object.keys(summary.todayItems[0]!).sort()).toEqual(['dueDate', 'dueTime', 'id', 'listTitle', 'priority', 'title']);
  });

  it('V02-01: overdue and upcoming items keep both keys and real values pass through', async () => {
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    await invoke('todo_create_item', { input: { todoListId: list.id, title: 'late', priority: 'low', dueDate: localDate(-1) } });
    await invoke('todo_create_item', {
      input: { todoListId: list.id, title: 'soon', priority: 'urgent', dueDate: localDate(1), dueTime: '09:30' },
    });

    const summary = await invoke<Summary>('todo_get_active_summary');
    expect(summary.overdueItems).toEqual([
      { id: expect.any(String), title: 'late', priority: 'low', dueDate: localDate(-1), dueTime: null, listTitle: 'L' },
    ]);
    expect(summary.upcomingHighPriority).toEqual([
      { id: expect.any(String), title: 'soon', priority: 'urgent', dueDate: localDate(1), dueTime: '09:30', listTitle: 'L' },
    ]);
  });

  it('V02-01: the prompt summary omits absent times instead of printing null (todo_repo.rs format_active_summary_for_prompt)', async () => {
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    await invoke('todo_create_item', { input: { todoListId: list.id, title: 'plain', priority: 'high', dueDate: localDate(0) } });
    await invoke('todo_create_item', {
      input: { todoListId: list.id, title: 'timed', priority: 'low', dueDate: localDate(0), dueTime: '18:00' },
    });
    const repo = vfs.host.ctx.vfsRepo.todos;
    const summary = repo.getActiveTodoSummary(vfs.host.ctx.storage.database('vfs'))!;
    const text = repo.formatActiveSummaryForPrompt(summary);
    expect(text).toContain('- [!] plain [L]');
    expect(text).toContain('- [ ] timed 截止 18:00 [L]');
    expect(text).not.toContain('null');
  });
});
