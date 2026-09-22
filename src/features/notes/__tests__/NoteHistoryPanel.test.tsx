import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { NoteHistoryPanel } from '../NoteHistoryPanel';
import { NotesAPI, type NoteHistoryRevision, type NoteHistorySummary } from '@/utils/notesApi';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/components/ui/DsDialog', () => ({
  DsDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null,
}));

const summary = (id: string, title = id): NoteHistorySummary => ({
  version_id: id, note_id: 'n1', title, parent_version_id: null, restored_from_version_id: null,
  source: 'edit', created_at: '2026-09-21T10:00:00.000Z', pinned: false, content_bytes: 20,
});
const revision = (id: string): NoteHistoryRevision => ({
  ...summary(id), content_md: `正文 ${id}\n\n未加载后缀\n\n`, tags: ['历史标签'],
  props: { subject: '历史属性' }, asset_refs: [{ kind: 'notes_asset', value: 'notes_assets/_global/n1/a.png' }],
  content_format: 'markdown-legacy', format_version: 1, serializer_version: 'markdown-v1',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => vi.resetAllMocks());

describe('note history API and independent panel', () => {
  it('restores a supported columns envelope whole and blocks future capabilities', async () => {
    let serializer = 'markdown-v1+ds-columns-v1';
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'notes_history_list') return { items: [summary('v1')], next_cursor: null };
      if (command === 'notes_history_get') return { ...revision('v1'), serializer_version: serializer };
      if (command === 'notes_history_restore_copy') return { id: 'copy', name: 'Copy', path: '/copy' };
      throw new Error(`unexpected command ${command}`);
    });
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /v1/ }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复为新副本' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('notes_history_restore_copy', { noteId: 'n1', versionId: 'v1' }));
    expect(screen.queryByRole('checkbox', { name: '只恢复选定行' })).toBeNull();
    serializer = 'markdown-v1+ds-columns-v999';
    await waitFor(() => expect((screen.getByRole('button', { name: /v1/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /v1/ }));
    await screen.findByText('此版本格式暂不支持恢复，请使用兼容版本。');
    expect((screen.getByRole('button', { name: '恢复为新副本' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('previews a line selection diff and restores that selection as a copy', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'notes_history_list') return { items: [summary('v1')], next_cursor: null };
      if (command === 'notes_history_get') return { ...revision('v1'), content_md: 'first\n\nsecond\n\nthird' };
      if (command === 'notes_history_current') return { title: 'Current', content_md: 'current', updated_at: 'token-1' };
      if (command === 'notes_history_restore_selection_copy') return { id: 'copy', name: 'Copy', path: '/copy' };
      throw new Error(`unexpected command ${command}`);
    });
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /v1/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '只恢复选定行' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '起始行' }), { target: { value: '3' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '结束行' }), { target: { value: '3' } });
    expect(screen.getByLabelText('选段恢复预览').textContent).toBe('second');
    fireEvent.click(screen.getByRole('button', { name: '与当前笔记比较' }));
    const diff = await screen.findByLabelText('恢复差异预览');
    expect(diff.textContent).toContain('- current');
    expect(diff.textContent).toContain('+ second');
    fireEvent.click(screen.getByRole('button', { name: '恢复为新副本' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('notes_history_restore_selection_copy', {
      noteId: 'n1', versionId: 'v1', selection: { start_line: 3, end_line: 3 },
    }));
  });

  it('holds the host lock through commit and refresh even when the dialog closes during IPC', async () => {
    let commit!: (node: unknown) => void, finishRefresh!: () => void;
    const order: string[] = [];
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'notes_history_list') return { items: [summary('v1')], next_cursor: null };
      if (command === 'notes_history_get') return revision('v1');
      if (command === 'notes_history_current') return { title: 'Current', content_md: 'current', updated_at: 'token' };
      if (command === 'notes_history_restore_current') { order.push('commit'); return new Promise(resolve => { commit = resolve; }); }
      throw new Error(String(command));
    });
    const props = { noteId: 'n1', onOpenChange: vi.fn(),
      beforeOverwrite: async () => { order.push('flush'); return true; },
      withOverwrite: async <T,>(operation: () => Promise<T>) => { order.push('lock'); try { return await operation(); } finally { order.push('unlock'); } },
      onRestoredCurrent: async () => { order.push('refresh'); await new Promise<void>(resolve => { finishRefresh = resolve; }); },
    };
    const mounted = render(<NoteHistoryPanel {...props} open />);
    fireEvent.click(await screen.findByRole('button', { name: /v1/ }));
    fireEvent.click(await screen.findByRole('button', { name: '覆盖当前笔记…' }));
    fireEvent.click(await screen.findByRole('button', { name: '保留当前版本并覆盖' }));
    await waitFor(() => expect(order).toEqual(['lock', 'flush', 'commit']));
    mounted.rerender(<NoteHistoryPanel {...props} open={false} />);
    commit({ id: 'n1', name: 'Restored', path: '/n1' });
    await waitFor(() => expect(order).toEqual(['lock', 'flush', 'commit', 'refresh']));
    finishRefresh();
    await waitFor(() => expect(order.at(-1)).toBe('unlock'));
  });

  it('requires draft protection and confirmation, rejects stale CAS, and can retry with a fresh diff', async () => {
    let token = 'old-token'; let fail = true;
    const guard = vi.fn(async () => true);
    const onRestoredCurrent = vi.fn();
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'notes_history_list') return { items: [summary('v1')], next_cursor: null };
      if (command === 'notes_history_get') return revision('v1');
      if (command === 'notes_history_current') return { title: 'Current', content_md: 'current', updated_at: token };
      if (command === 'notes_history_restore_current') {
        expect(guard).toHaveBeenCalled();
        if (fail) throw new Error('notes.conflict');
        return { id: 'n1', name: 'Restored', path: '/n1' };
      }
      throw new Error(`unexpected command ${command}`);
    });
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} beforeOverwrite={guard} onRestoredCurrent={onRestoredCurrent} />);
    fireEvent.click(await screen.findByRole('button', { name: /v1/ }));
    fireEvent.click(await screen.findByRole('button', { name: '覆盖当前笔记…' }));
    await screen.findByRole('group', { name: '确认覆盖当前笔记' });
    expect(invoke).not.toHaveBeenCalledWith('notes_history_restore_current', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '保留当前版本并覆盖' }));
    expect((await screen.findByRole('alert')).textContent).toContain('notes.conflict');
    expect(onRestoredCurrent).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('notes_history_restore_current', { noteId: 'n1', versionId: 'v1', expectedUpdatedAt: 'old-token', selection: null });
    fail = false; token = 'new-token';
    fireEvent.click(screen.getByRole('button', { name: '覆盖当前笔记…' }));
    fireEvent.click(await screen.findByRole('button', { name: '保留当前版本并覆盖' }));
    await waitFor(() => expect(onRestoredCurrent).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith('notes_history_restore_current', { noteId: 'n1', versionId: 'v1', expectedUpdatedAt: 'new-token', selection: null });
  });

  it('does not write when the draft guard cancels and refuses future format restores', async () => {
    let future = false;
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'notes_history_list') return { items: [summary('v1')], next_cursor: null };
      if (command === 'notes_history_get') return { ...revision('v1'), format_version: future ? 999 : 1 };
      if (command === 'notes_history_current') return { title: 'Current', content_md: 'current', updated_at: 'token' };
      throw new Error(`unexpected write ${command}`);
    });
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} beforeOverwrite={async () => false} onRestoredCurrent={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /v1/ }));
    fireEvent.click(await screen.findByRole('button', { name: '覆盖当前笔记…' }));
    fireEvent.click(await screen.findByRole('button', { name: '保留当前版本并覆盖' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '取消覆盖' }) as HTMLButtonElement).disabled).toBe(false));
    expect(invoke).not.toHaveBeenCalledWith('notes_history_restore_current', expect.anything());
    future = true;
    fireEvent.click(screen.getByRole('button', { name: /v1/ }));
    await screen.findByText('此版本格式暂不支持恢复，请使用兼容版本。');
    expect((screen.getByRole('button', { name: '恢复为新副本' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves configurable retention only after backend success and allows a failed save to retry', async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'notes_history_list') return { items: [], next_cursor: null };
      if (command === 'notes_history_get_retention') return { edit_bucket_seconds: 300, max_edit_versions: 100 };
      if (command === 'notes_history_set_retention') {
        if (fail) throw new Error('retention storage unavailable');
        return (args as { policy: unknown }).policy;
      }
      throw new Error(`unexpected command ${command}`);
    });
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} />);
    await waitFor(() => expect((screen.getByRole('button', { name: '配置历史保留' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '配置历史保留' }));
    const interval = await screen.findByRole('spinbutton', { name: '合并间隔（秒，0 为不合并）' });
    fireEvent.change(interval, { target: { value: '0' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '普通编辑版本上限（0 为不限）' }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存保留规则' }));
    expect((await screen.findByRole('alert')).textContent).toContain('retention storage unavailable');
    expect(screen.queryByText('保留规则已保存')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '保存保留规则' }));
    await screen.findByText('保留规则已保存');
    expect(invoke).toHaveBeenCalledWith('notes_history_set_retention', { policy: { edit_bucket_seconds: 0, max_edit_versions: null } });
  });

  it('sends scoped cursor/read/restore-copy IPC parameters', async () => {
    vi.mocked(invoke).mockResolvedValue({ items: [], next_cursor: null });
    await NotesAPI.historyList('note_id', 17, 10);
    expect(invoke).toHaveBeenLastCalledWith('notes_history_list', { noteId: 'note_id', cursor: 17, limit: 10, pinnedOnly: false });
    await NotesAPI.historyList('note_id', null, 30, true);
    expect(invoke).toHaveBeenLastCalledWith('notes_history_list', { noteId: 'note_id', cursor: null, limit: 30, pinnedOnly: true });
    await NotesAPI.historyGet('note_id', 'version_id');
    expect(invoke).toHaveBeenLastCalledWith('notes_history_get', { noteId: 'note_id', versionId: 'version_id' });
    await NotesAPI.historyRestoreCopy('note_id', 'version_id');
    expect(invoke).toHaveBeenLastCalledWith('notes_history_restore_copy', { noteId: 'note_id', versionId: 'version_id' });
    await NotesAPI.historySetPinned('note_id', 'version_id', false);
    expect(invoke).toHaveBeenLastCalledWith('notes_history_set_pinned', { noteId: 'note_id', versionId: 'version_id', pinned: false });
  });

  it('previews complete stored content and restores a copy once without changing the original', async () => {
    const restore = deferred<{ id: string; name: string; path: string }>();
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'notes_history_list') return { items: [summary('v1')], next_cursor: null };
      if (command === 'notes_history_get') return revision('v1');
      if (command === 'notes_history_restore_copy') return restore.promise;
      throw new Error(`unexpected command ${command}`);
    });
    const onRestoredCopy = vi.fn();
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} onRestoredCopy={onRestoredCopy} />);
    fireEvent.click(await screen.findByRole('button', { name: /v1/ }));
    const body = await screen.findByLabelText('历史版本正文（只读 Markdown）');
    expect(body.textContent).toBe(revision('v1').content_md);
    expect(screen.getByText('历史属性')).toBeTruthy();
    const button = screen.getByRole('button', { name: '恢复为新副本' });
    fireEvent.click(button); fireEvent.click(button);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'notes_history_restore_copy')).toHaveLength(1);
    const node = { id: 'new-note', name: 'v1（历史副本）', path: '/new-note' };
    await act(async () => { restore.resolve(node); });
    expect(onRestoredCopy).toHaveBeenCalledWith(node);
    expect(screen.getByRole('status').textContent).toContain('已创建历史副本');
    expect(vi.mocked(invoke).mock.calls.every(([command]) => String(command).startsWith('notes_history_'))).toBe(true);
  });

  it('discards an older preview response when a newer version is selected', async () => {
    const old = deferred<NoteHistoryRevision>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'notes_history_list') return { items: [summary('v1'), summary('v2')], next_cursor: null };
      if ((args as { versionId?: string }).versionId === 'v1') return old.promise;
      return revision('v2');
    });
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /v1/ }));
    fireEvent.click(screen.getByRole('button', { name: /v2/ }));
    await screen.findByLabelText('历史版本正文（只读 Markdown）');
    await act(async () => { old.resolve(revision('v1')); });
    expect(screen.getByLabelText('历史版本正文（只读 Markdown）').textContent).toContain('正文 v2');
  });

  it('discards pending note history on note switch and supports cursor pagination', async () => {
    const old = deferred<{ items: NoteHistorySummary[]; next_cursor: null }>();
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { noteId, cursor } = args as { noteId: string; cursor: number | null };
      if (noteId === 'old') return old.promise;
      return cursor === null ? { items: [summary('new')], next_cursor: 5 } : { items: [summary('older')], next_cursor: null };
    });
    const view = render(<NoteHistoryPanel noteId="old" open onOpenChange={vi.fn()} />);
    view.rerender(<NoteHistoryPanel noteId="new" open onOpenChange={vi.fn()} />);
    await screen.findByRole('button', { name: /new/ });
    await act(async () => { old.resolve({ items: [summary('stale')], next_cursor: null }); });
    expect(screen.queryByRole('button', { name: /stale/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '加载更早版本' }));
    await screen.findByRole('button', { name: /older/ });
    await waitFor(() => expect(screen.queryByRole('button', { name: '加载更早版本' })).toBeNull());
  });

  it('shows missing or pruned versions without substituting the current document', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'notes_history_list') return { items: [summary('missing')], next_cursor: null };
      throw new Error('版本不存在或已清理');
    });
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /missing/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('版本不存在或已清理');
    expect(screen.queryByLabelText('历史版本正文（只读 Markdown）')).toBeNull();
    expect((screen.getByRole('button', { name: '恢复为新副本' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not pin on preview and offers explicit retain, cancel release, and confirm release', async () => {
    let pinned = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'notes_history_list') return { items: (args as { pinnedOnly: boolean }).pinnedOnly && !pinned ? [] : [{ ...summary('v1'), pinned }], next_cursor: null };
      if (command === 'notes_history_get') return { ...revision('v1'), pinned };
      if (command === 'notes_history_set_pinned') {
        pinned = (args as { pinned: boolean }).pinned;
        return { ...summary('v1'), pinned };
      }
      throw new Error(`unexpected command ${command}`);
    });
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /v1/ }));
    await screen.findByLabelText('历史版本正文（只读 Markdown）');
    expect(invoke).not.toHaveBeenCalledWith('notes_history_set_pinned', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '长期保留此版本' }));
    fireEvent.click(await screen.findByRole('button', { name: '解除长期保留' }));
    expect(screen.getByRole('group', { name: '确认解除版本保留' }).textContent).toContain('普通编辑版本之后可能被合并或自动清理');
    fireEvent.click(screen.getByRole('button', { name: '继续保留' }));
    expect(pinned).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('notes_history_set_pinned', expect.objectContaining({ pinned: false }));
    fireEvent.click(screen.getByRole('button', { name: '解除长期保留' }));
    fireEvent.click(screen.getByRole('button', { name: '确认解除保留' }));
    await screen.findByRole('button', { name: '长期保留此版本' });
    expect(pinned).toBe(false);
    expect(screen.getByLabelText('历史版本正文（只读 Markdown）').textContent).toBe(revision('v1').content_md);
    // Reading it again must not silently recreate the released pin.
    fireEvent.click(screen.getByRole('button', { name: /v1/ }));
    await screen.findByLabelText('历史版本正文（只读 Markdown）');
    expect(pinned).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: '只看已长期保留的版本' }));
    await screen.findByText(/没有已长期保留的版本/);
  });

  it('lists old retained versions separately with pagination and releases a legacy preview pin', async () => {
    let released = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'notes_history_list') {
        const { pinnedOnly, cursor } = args as { pinnedOnly: boolean; cursor: number | null };
        if (!pinnedOnly) return { items: [summary('recent')], next_cursor: 50 };
        if (cursor === null) return { items: [{ ...summary('older'), pinned: true }], next_cursor: released ? null : 10 };
        return { items: [{ ...summary('legacy'), pinned: true }], next_cursor: null };
      }
      if (command === 'notes_history_get') return { ...revision('legacy'), pinned: true };
      if (command === 'notes_history_set_pinned') { released = true; return summary('legacy'); }
      throw new Error(`unexpected command ${command}`);
    });
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} />);
    await screen.findByRole('button', { name: /recent/ });
    fireEvent.click(screen.getByRole('checkbox', { name: '只看已长期保留的版本' }));
    await screen.findByRole('button', { name: /older/ });
    expect(screen.queryByRole('button', { name: /recent/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '加载更早版本' }));
    fireEvent.click(await screen.findByRole('button', { name: /legacy/ }));
    fireEvent.click(await screen.findByRole('button', { name: '解除长期保留' }));
    fireEvent.click(screen.getByRole('button', { name: '确认解除保留' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /legacy/ })).toBeNull());
    expect(screen.queryByText(/没有已长期保留的版本/)).toBeNull();
    expect(screen.getByRole('button', { name: /older/ })).toBeTruthy();
  });

  it('does not display a successful release when the backend rejects it', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'notes_history_list') return { items: [{ ...summary('v1'), pinned: true }], next_cursor: null };
      if (command === 'notes_history_get') return { ...revision('v1'), pinned: true };
      throw new Error('数据库暂不可写');
    });
    render(<NoteHistoryPanel noteId="n1" open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /v1/ }));
    fireEvent.click(await screen.findByRole('button', { name: '解除长期保留' }));
    fireEvent.click(screen.getByRole('button', { name: '确认解除保留' }));
    expect((await screen.findByRole('alert')).textContent).toContain('数据库暂不可写');
    expect(screen.getByRole('group', { name: '确认解除版本保留' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '长期保留此版本' })).toBeNull();
  });

  it('does not apply an old note retention response to a newly opened note', async () => {
    const pending = deferred<NoteHistorySummary>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const { noteId } = args as { noteId: string };
      if (command === 'notes_history_list') return { items: [summary(noteId)], next_cursor: null };
      if (command === 'notes_history_get') return revision(noteId);
      return pending.promise;
    });
    const view = render(<NoteHistoryPanel noteId="old" open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /old/ }));
    await screen.findByLabelText('历史版本正文（只读 Markdown）');
    fireEvent.click(screen.getByRole('button', { name: '长期保留此版本' }));
    view.rerender(<NoteHistoryPanel noteId="new" open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /new/ }));
    await screen.findByLabelText('历史版本正文（只读 Markdown）');
    await act(async () => pending.resolve({ ...summary('old'), pinned: true }));
    expect(screen.getByLabelText('历史版本正文（只读 Markdown）').textContent).toContain('正文 new');
    expect(screen.queryByRole('button', { name: '解除长期保留' })).toBeNull();
  });
});
