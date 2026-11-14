import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';
import { VfsError, VfsErrorCode } from '@/shared/result';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), getContent: vi.fn(), setMetadata: vi.fn(), update: vi.fn(),
  editorProps: null as any,
}));
vi.mock('@/dstu', () => ({
  dstu: {
    get: mocks.get, getContent: mocks.getContent, setMetadata: mocks.setMetadata, update: mocks.update,
    watch: () => () => {},
  },
  updatedAtToVersionToken: (ms: number | null | undefined) => typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined,
}));
vi.mock('@/features/notes/markdownWindowSettings', () => ({ loadInitialLineWindowSetting: async () => 100 }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/stores/systemStatusStore', () => ({ useSystemStatusStore: Object.assign(
  (selector: (state: { maintenanceMode: boolean }) => unknown) => selector({ maintenanceMode: false }),
  { getState: () => ({ maintenanceMode: false }) },
) }));
vi.mock('@/features/workbench/apps/notes/wikilinkRenameSync', () => ({
  syncWikiLinksAfterNoteRename: vi.fn(async () => ({ scanFailed: false, updatedSources: 0, skippedDirtySources: 0, failedSources: 0, truncated: false })),
}));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
vi.mock('@/components/layout', () => ({ useMobileSubviewChrome: () => false }));
vi.mock('@/features/notes/NotesCrepeEditor', () => ({
  NotesCrepeEditor: (props: any) => { mocks.editorProps = props; return <div data-testid="editor" />; },
}));
vi.mock('@/features/notes/NotesContextPanel', () => ({ NotesContextPanel: () => null }));
import NoteContentView from '@/features/learning-hub/apps/views/NoteContentView';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const conflict = () => ({ ok: false as const, error: new VfsError(VfsErrorCode.CONFLICT, 'stale expected_updated_at') });
const conflictMessage = new VfsError(VfsErrorCode.CONFLICT, 'stale expected_updated_at').toUserMessage();
const iso = (ms: number) => new Date(ms).toISOString();

// Backend OCC: every write must carry the current updated_at and advances it.
let disk: DstuNode;
let diskBody: string;
let clock: number;
function bump(patch: Partial<DstuNode> = {}, metadata: Record<string, unknown> = {}) {
  clock += 1000;
  disk = { ...disk, ...patch, updatedAt: clock, metadata: { ...disk.metadata, ...metadata } };
}

/** Body writes through the same OCC check as metadata writes. */
function occBodyUpdates() {
  mocks.update.mockImplementation(async (_path: string, content: string, _type: string, options?: { expectedUpdatedAtMs?: number }) => {
    if (options?.expectedUpdatedAtMs !== disk.updatedAt) return conflict();
    diskBody = content;
    bump();
    return ok({ ...disk });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.editorProps = null;
  clock = 1000;
  disk = { id: 'note_a', path: '/note_a', type: 'note', name: '旧标题', createdAt: 1000, updatedAt: clock, metadata: { tags: ['old'] } };
  diskBody = 'body\n';
  mocks.get.mockImplementation(async () => ok(disk));
  mocks.getContent.mockImplementation(async () => ok(diskBody));
  mocks.setMetadata.mockImplementation(async (_path: string, metadata: { title?: string; tags?: string[] }, expected?: string) => {
    if (expected !== iso(disk.updatedAt)) return conflict();
    bump(metadata.title !== undefined ? { name: metadata.title } : {}, metadata.tags ? { tags: metadata.tags } : {});
    return ok(undefined);
  });
});
afterEach(() => cleanup());

async function openNote() {
  render(<NoteContentView node={disk} isActive />);
  await screen.findByTestId('editor');
  return mocks.editorProps;
}

/** The body autosave has reached the backend (updated_at advanced) but its response is still on the way. */
async function bodySaveInFlight(props: any) {
  let deliver!: () => void;
  mocks.update.mockImplementationOnce(async (_path: string, content: string) => {
    diskBody = content;
    bump();
    const savedAt = disk.updatedAt;
    await new Promise<void>((resolve) => { deliver = resolve; });
    return ok({ ...disk, updatedAt: savedAt });
  });
  let saved!: Promise<unknown>;
  act(() => { saved = props.onSave('body edited\n'); });
  await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
  return async () => { await act(async () => { deliver(); await saved; }); };
}

describe('NoteContentView metadata writes racing the body autosave', () => {
  it('RF-W09-note-metadata-conflict-retry: a title saved while the body autosave is in flight is kept', async () => {
    const props = await openNote();
    const finishBody = await bodySaveInFlight(props);
    await act(async () => { await props.onTitleChange('新标题'); });
    expect(disk.name).toBe('新标题');
    expect(mocks.setMetadata).toHaveBeenCalledTimes(2);
    expect(mocks.setMetadata.mock.calls[1][2]).toBe(iso(2000));
    await finishBody();
  });

  it('RF-W09-note-metadata-conflict-retry: tags saved while the body autosave is in flight are kept', async () => {
    const props = await openNote();
    const finishBody = await bodySaveInFlight(props);
    await act(async () => { await props.onTagsChange(['old', 'new']); });
    expect(disk.metadata?.tags).toEqual(['old', 'new']);
    await finishBody();
  });

  it('a title renamed elsewhere is still a conflict: no retry, the other rename survives', async () => {
    const props = await openNote();
    bump({ name: '别处改的标题' });
    await expect(props.onTitleChange('新标题')).rejects.toThrow(conflictMessage);
    expect(mocks.setMetadata).toHaveBeenCalledTimes(1);
    expect(disk.name).toBe('别处改的标题');
  });

  it('tags changed elsewhere are still a conflict: no retry', async () => {
    const props = await openNote();
    bump({}, { tags: ['theirs'] });
    await expect(props.onTagsChange(['mine'])).rejects.toThrow(conflictMessage);
    expect(mocks.setMetadata).toHaveBeenCalledTimes(1);
    expect(disk.metadata?.tags).toEqual(['theirs']);
  });

  it('RF-W09-note-metadata-conflict-retry: after a retried tags write, the next autosave does not overwrite a body written elsewhere', async () => {
    const props = await openNote();
    // Another window wrote the body; this window is dirty, so its watch only records the newer version.
    bump();
    diskBody = 'theirs\n';
    await act(async () => { await props.onTagsChange(['old', 'new']); });
    expect(disk.metadata?.tags).toEqual(['old', 'new']);
    expect(mocks.setMetadata).toHaveBeenCalledTimes(2);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    occBodyUpdates();
    const conflicts: unknown[] = [];
    const onConflict = (event: Event) => conflicts.push((event as CustomEvent).detail);
    window.addEventListener('notes:content-conflict', onConflict);
    try {
      await act(async () => { await props.onSave('mine\n').catch(() => {}); });
    } finally {
      window.removeEventListener('notes:content-conflict', onConflict);
    }
    expect(await mocks.update.mock.results[0].value).toMatchObject({ ok: false });
    expect(conflicts).toHaveLength(1);
    expect(diskBody).toBe('theirs\n');
  });

  it('RF-W09-note-metadata-conflict-retry: after a retried title write, the next autosave does not overwrite a body written elsewhere', async () => {
    const props = await openNote();
    bump();
    diskBody = 'theirs\n';
    await act(async () => { await props.onTitleChange('新标题'); });
    expect(disk.name).toBe('新标题');
    expect(mocks.setMetadata).toHaveBeenCalledTimes(2);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    occBodyUpdates();
    const conflicts: unknown[] = [];
    const onConflict = (event: Event) => conflicts.push((event as CustomEvent).detail);
    window.addEventListener('notes:content-conflict', onConflict);
    try {
      await act(async () => { await props.onSave('mine\n').catch(() => {}); });
    } finally {
      window.removeEventListener('notes:content-conflict', onConflict);
    }
    expect(await mocks.update.mock.results[0].value).toMatchObject({ ok: false });
    expect(conflicts).toHaveLength(1);
    expect(diskBody).toBe('theirs\n');
  });

  it('RF-W09-note-metadata-conflict-retry: after a retry that raced its own body save, the next autosave still lands without a conflict', async () => {
    const props = await openNote();
    const finishBody = await bodySaveInFlight(props);
    await act(async () => { await props.onTitleChange('新标题'); });
    await finishBody();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    occBodyUpdates();
    const conflicts: unknown[] = [];
    const onConflict = (event: Event) => conflicts.push(event);
    window.addEventListener('notes:content-conflict', onConflict);
    try {
      await act(async () => { await props.onSave('body edited again\n'); });
    } finally {
      window.removeEventListener('notes:content-conflict', onConflict);
    }
    expect(conflicts).toHaveLength(0);
    expect(diskBody).toBe('body edited again\n');
    expect(disk.name).toBe('新标题');
  });

  it('RF-W09-note-metadata-conflict-retry: retries once only, even if the body keeps landing in between', async () => {
    const props = await openNote();
    mocks.setMetadata.mockImplementation(async () => { bump(); return conflict(); });
    await expect(props.onTitleChange('新标题')).rejects.toThrow(conflictMessage);
    expect(mocks.setMetadata).toHaveBeenCalledTimes(2);
    expect(disk.name).toBe('旧标题');
  });

  it('RF-W09-note-metadata-conflict-retry: a failed re-read reports the conflict without retrying', async () => {
    const props = await openNote();
    bump();
    mocks.get.mockResolvedValueOnce({ ok: false, error: new VfsError(VfsErrorCode.UNKNOWN, 'disk unavailable') });
    await expect(props.onTitleChange('新标题')).rejects.toThrow(conflictMessage);
    expect(mocks.setMetadata).toHaveBeenCalledTimes(1);
    expect(disk.name).toBe('旧标题');
  });
});
