import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';
import { __resetContentDirtyRegistry, registerContentDirtyChecker } from '@/features/workbench/apps/content/contentDirtyRegistry';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), getContent: vi.fn(), setMetadata: vi.fn(), update: vi.fn(),
  watchers: new Set<(event: { type: string; node: DstuNode; path: string }) => void>(),
  editorProps: null as any,
  mobile: false,
  maintenance: false,
}));
vi.mock('@/dstu', () => ({
  dstu: {
    get: mocks.get, getContent: mocks.getContent, setMetadata: mocks.setMetadata, update: mocks.update,
    watch: (_path: string, callback: (event: { type: string; node: DstuNode; path: string }) => void) => {
      mocks.watchers.add(callback); return () => mocks.watchers.delete(callback);
    },
  },
  updatedAtToVersionToken: (ms: number) => Number.isFinite(ms) ? new Date(ms).toISOString() : undefined,
}));
vi.mock('@/features/notes/markdownWindowSettings', () => ({ loadInitialLineWindowSetting: async () => 100 }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/stores/systemStatusStore', () => ({ useSystemStatusStore: Object.assign(
  (selector: (state: { maintenanceMode: boolean }) => unknown) => selector({ maintenanceMode: mocks.maintenance }),
  { getState: () => ({ maintenanceMode: mocks.maintenance }) },
) }));
vi.mock('@/features/notes/noteRelations', () => ({
  NOTE_RELATIONS_CHANGED: 'notes:relations-changed', isNoteRelationUsable: () => true,
  noteRelationsService: { list: async () => [], put: vi.fn(), delete: vi.fn(), referenceStatus: vi.fn() },
}));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => mocks.mobile }));
vi.mock('@/components/layout', () => ({ useMobileSubviewChrome: () => false }));
vi.mock('@/features/notes/NotesCrepeEditor', () => ({
  NotesCrepeEditor: (props: any) => { mocks.editorProps = props; return <div data-testid="editor">{props.headerActions}</div>; },
}));
vi.mock('@/features/notes/NotesContextPanel', () => ({
  NotesContextPanel: (props: any) => <aside data-testid="context">{props.beforeOutline}</aside>,
}));
import NoteContentView from '@/features/learning-hub/apps/views/NoteContentView';

function makeNode(id = 'note_a', updatedAt = 1000, props: Record<string, unknown> = {}): DstuNode {
  return { id, path: `/${id}`, type: 'note', name: id, createdAt: 1000, updatedAt, metadata: { props, tags: [] } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const ok = <T,>(value: T) => ({ ok: true as const, value });
const failure = (message: string) => ({ ok: false as const, error: { toUserMessage: () => message } });
let disk: DstuNode;

async function openPanel(node = makeNode(), readOnly = false) {
  const view = render(<NoteContentView node={node} isActive readOnly={readOnly} />);
  await screen.findByTestId('editor');
  fireEvent.click(screen.getByRole(mocks.mobile ? 'menuitem' : 'button', { name: /属性|contextPanel.title/ }));
  await screen.findByLabelText('课程');
  return view;
}

beforeEach(() => {
  vi.clearAllMocks(); __resetContentDirtyRegistry(); mocks.watchers.clear();
  mocks.mobile = false; mocks.maintenance = false; mocks.editorProps = null;
  disk = makeNode('note_a', 2000, { status: 'draft', score: 8, study_mastery: '旧状态' });
  mocks.get.mockImplementation(async () => ok(disk));
  mocks.getContent.mockResolvedValue(ok('完整原文'));
  mocks.update.mockImplementation(async () => ok({ ...disk, updatedAt: disk.updatedAt + 1000 }));
  mocks.setMetadata.mockImplementation(async (_path: string, metadata: Record<string, unknown>) => {
    disk = { ...disk, updatedAt: disk.updatedAt + 1000, metadata: { ...disk.metadata, ...metadata } };
    mocks.watchers.forEach((callback) => callback({ type: 'updated', node: disk, path: disk.path }));
    return ok(undefined);
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('classic-shell learning properties', () => {
  it.each([false, true])('mounts the real props editor in the %s mobile context and persists fresh metadata', async (mobile) => {
    mocks.mobile = mobile;
    const unregister = registerContentDirtyChecker('note', 'note_a', () => true);
    const { unmount } = await openPanel(makeNode('note_a', 1000, { status: 'stale-prop' }));
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.queryByText('stale-prop')).toBeNull();
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: '数学' } });
    // An unseen concurrent metadata update must be preserved by the preflight read.
    disk = { ...disk, updatedAt: 3000, metadata: { props: { ...disk.metadata?.props as object, addedElsewhere: true } } };
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    await waitFor(() => expect(mocks.setMetadata).toHaveBeenCalledWith('/note_a', { props: {
      status: 'draft', score: 8, study_mastery: '旧状态', addedElsewhere: true, study_course: '数学',
    } }, new Date(3000).toISOString()));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存学习属性' })).toBeDisabled());
    fireEvent.change(screen.getByLabelText('章节'), { target: { value: '第二章' } });
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    await waitFor(() => expect(mocks.setMetadata).toHaveBeenLastCalledWith('/note_a', expect.anything(), new Date(4000).toISOString()));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存学习属性' })).toBeDisabled());
    // Metadata edits must not grant the dirty body a newer OCC baseline.
    await act(async () => { await mocks.editorProps.onSave('正文草稿'); });
    expect(mocks.update).toHaveBeenCalledWith('/note_a', '正文草稿', 'note', { expectedUpdatedAtMs: 2000 });
    unregister(); unmount();
    await openPanel(makeNode());
    expect(screen.getByLabelText('课程')).toHaveValue('数学');
    expect(screen.getByLabelText('章节')).toHaveValue('第二章');
  });

  it('rejects same-key conflicts, refreshes the baseline, and retains the draft for explicit retry', async () => {
    disk = makeNode('note_a', 2000, { study_course: '数学', status: 'keep' });
    await openPanel();
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: '我的课程' } });
    disk = makeNode('note_a', 3000, { study_course: '其他位置的课程', status: 'keep' });
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('已在其他位置修改');
    expect(mocks.setMetadata).not.toHaveBeenCalled();
    expect(screen.getByLabelText('课程')).toHaveValue('我的课程');
    fireEvent.click(screen.getByRole('button', { name: '已核对最新值，保留草稿重试' }));
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    await waitFor(() => expect(mocks.setMetadata).toHaveBeenCalledWith('/note_a', { props: { study_course: '我的课程', status: 'keep' } }, new Date(3000).toISOString()));
  });

  it('keeps the draft after write failure and never writes after a failed latest-node read', async () => {
    await openPanel();
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: '草稿课程' } });
    mocks.setMetadata.mockResolvedValueOnce(failure('版本冲突'));
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('版本冲突');
    expect(screen.getByLabelText('课程')).toHaveValue('草稿课程');
    mocks.get.mockResolvedValueOnce(failure('读取失败'));
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
    expect(mocks.setMetadata).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('课程')).toHaveValue('草稿课程');
  });

  it('cancels a pending preflight on note switch without leaking the previous draft', async () => {
    const view = await openPanel();
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: 'A 的草稿' } });
    const original = disk;
    const pending = deferred<ReturnType<typeof ok<DstuNode>>>();
    mocks.get.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    disk = makeNode('note_b', 5000, { study_course: 'B 的课程' });
    view.rerender(<NoteContentView node={disk} isActive />);
    await waitFor(() => expect(screen.getByLabelText('课程')).toHaveValue('B 的课程'));
    await act(async () => pending.resolve(ok(original)));
    expect(mocks.setMetadata).not.toHaveBeenCalled();
    expect(screen.getByLabelText('课程')).toHaveValue('B 的课程');
  });

  it('disables read-only editing and blocks maintenance writes while retaining inputs', async () => {
    const view = await openPanel(makeNode(), true);
    expect(screen.getByLabelText('课程')).toBeDisabled();
    view.rerender(<NoteContentView node={makeNode()} isActive readOnly={false} />);
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: '待保存' } });
    mocks.maintenance = true;
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('维护模式');
    expect(mocks.setMetadata).not.toHaveBeenCalled();
    expect(screen.getByLabelText('课程')).toHaveValue('待保存');
  });

  it('rejects an out-of-order preflight snapshot after a newer watch event', async () => {
    const unregister = registerContentDirtyChecker('note', 'note_a', () => true);
    await openPanel();
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: '输入保留' } });
    const stale = disk;
    const pending = deferred<ReturnType<typeof ok<DstuNode>>>();
    mocks.get.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    disk = { ...disk, updatedAt: 3000, metadata: { props: { study_chapter: '新的章节' } } };
    act(() => mocks.watchers.forEach((callback) => callback({ type: 'updated', node: disk, path: disk.path })));
    await act(async () => pending.resolve(ok(stale)));
    expect(await screen.findByRole('alert')).toHaveTextContent('版本已过期');
    expect(mocks.setMetadata).not.toHaveBeenCalled();
    expect(screen.getByLabelText('章节')).toHaveValue('新的章节');
    expect(screen.getByLabelText('课程')).toHaveValue('输入保留');
    unregister();
  });
});
