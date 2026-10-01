import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { EditorState } from '@milkdown/prose/state';
import { editorViewCtx } from '@milkdown/kit/core';
import type { CrepeEditorApi, CrepeDocumentCapabilities } from '@/components/crepe/types';
import { createBlockTransferCodec, createBlockTransferService } from '@/components/crepe/blockTransfer/service';
import { installBlockLinkBridge, resolveBlockLinkOwner } from '@/components/crepe/plugins/blockIdentity/links';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { NotesAPI } from '@/utils/notesApi';
import { registerNoteEditor, unregisterNoteEditor } from '@/features/workbench/agent/drivers/noteDriver';
import { getWikilinkNotesCache, refreshWikilinkNotesCache } from './wikilinkNotesCache';
import { noteHostCoordinator, type NoteHostParticipant } from './noteHostCoordinator';
import { assertFullDocumentBaseline, assertNoteContentSize, type FullDocumentSearchApi, type FullDocumentSnapshot } from './fullDocument';

/** Review candidates stay outside the live view until storage confirms the CAS. */
export async function applyReviewedNote(api: FullDocumentSearchApi, markdown: string, baseline: FullDocumentSnapshot) {
  assertFullDocumentBaseline(api.getFullDocument(), baseline);
  assertNoteContentSize(markdown);
  const canonical = api.normalizeMarkdown?.(markdown) ?? markdown;
  await noteHostCoordinator.withLockedNotes([baseline.noteId], async () => {
    assertFullDocumentBaseline(api.getFullDocument(), baseline);
    await noteHostCoordinator.flushPendingSaves([baseline.noteId]);
    const current = api.getFullDocument();
    const normalize = (value: string) => api.normalizeMarkdown?.(value) ?? value;
    if (normalize(current.markdown) !== normalize(baseline.markdown)) throw new Error('审阅正文已变化，请重新生成建议。');
    const expected = api.getStorageUpdatedAt?.();
    if (!expected) throw new Error('审阅缺少保存版本，请重新打开笔记。');
    await noteHostCoordinator.invoke('notes_update', { note: {
      id: baseline.noteId, content_md: canonical, expected_updated_at: expected, capabilities: ['ds-columns-v1'],
    } });
  });
  return api.getFullDocument();
}

export interface NoteFormatStatus {
  note_id: string; content_format: string; format_version: number; serializer_version: string;
  required_capabilities: string[]; updated_at: string;
}
const formats = new Map<string, NoteFormatStatus>();
export function noteNeedsColumnsWriter(noteId: string) {
  return formats.get(noteId)?.required_capabilities?.includes('ds-columns-v1') === true;
}
export async function readNoteFormat(noteId: string): Promise<NoteFormatStatus> {
  const format = await invoke<NoteFormatStatus>('notes_get_format', { noteId });
  if (!format || format.note_id !== noteId) throw new Error('无法确认笔记格式。');
  formats.set(noteId, format);
  return format;
}
export function supportsNoteFormat(format: NoteFormatStatus): boolean {
  const base = format.content_format === 'markdown-blocks' ? 'blocks-v1' : 'markdown-v1';
  return format.format_version === 1 && ['markdown-legacy', 'markdown-blocks'].includes(format.content_format)
    && [base, `${base}+ds-columns-v1`].includes(format.serializer_version)
    && (format.required_capabilities ?? []).every(capability => capability === 'ds-columns-v1');
}
export function applyNoteFormat(api: CrepeEditorApi, format: NoteFormatStatus): CrepeDocumentCapabilities {
  const supported = supportsNoteFormat(format);
  const grant = { noteId: format.note_id, writable: supported, capabilities: format.required_capabilities ?? [] };
  api.setDocumentCapabilities?.(grant);
  api.setBlockIdentityMode?.(supported && format.content_format === 'markdown-blocks');
  if (!supported) throw new Error('此笔记格式需要更新版本的编辑器；已暂停编辑。');
  return grant;
}

export function resetNoteUndo(api: CrepeEditorApi) {
  api.getCrepe()?.editor.action(ctx => {
    const view = ctx.get(editorViewCtx);
    const { doc, selection, plugins, schema } = view.state;
    view.updateState(EditorState.create({ doc, selection, plugins, schema }));
  });
}

async function listNotes() {
  await refreshWikilinkNotesCache();
  return getWikilinkNotesCache().map(note => ({ id: note.id, title: note.title, path: note.path ?? `/${note.id}` }));
}
async function readNote(noteId: string) {
  const current = await NotesAPI.historyCurrent(noteId);
  return { noteId, content: current.content_md, updatedAt: current.updated_at };
}

let bridgeUsers = 0;
let stopBridge: (() => void) | undefined;
function retainBlockBridge() {
  if (bridgeUsers++ === 0) stopBridge = installBlockLinkBridge({
    resolveTarget: async target => {
      const parser = noteHostCoordinator.get(target.noteId) ?? noteHostCoordinator.all((await listNotes()).map(note => note.id))[0];
      const crepe = parser?.api.getCrepe();
      if (!crepe) throw new Error('笔记编辑器尚未就绪。');
      const codec = crepe.editor.action(createBlockTransferCodec);
      return resolveBlockLinkOwner(target, {
        readMarkdown: async noteId => {
          const live = noteHostCoordinator.get(noteId);
          if (live) return live.api.getFullDocument().markdown;
          try { return (await readNote(noteId)).content; }
          catch (error) {
            // A moved block can outlive its original page. Only a deleted routing
            // hint may be skipped; I/O failures must not masquerade as deletion.
            const { dstu } = await import('@/dstu');
            const node = await dstu.get(`/${noteId}`);
            if (node.ok && !node.value) return null;
            throw error;
          }
        },
        listNoteIds: async () => (await listNotes()).map(note => note.id), parse: codec.parse,
      });
    },
    openNote: async noteId => {
      window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', { detail: { noteId, source: 'notes-editor' } }));
      const participant = await noteHostCoordinator.waitFor(noteId);
      await participant.api.materializeFullDocument();
      return { focusBlock: (id: string) => participant.api.focusBlock?.(id) ?? false };
    },
    onMissing: () => showGlobalNotification('warning', '引用的笔记块已删除或无法定位。'),
    onError: error => showGlobalNotification('error', error instanceof Error ? error.message : String(error)),
  });
  return () => { if (--bridgeUsers === 0) { stopBridge?.(); stopBridge = undefined; } };
}

/** Bind the base API (whose closures own block actions) to the full host authority. */
export function bindNoteEditorHost(base: CrepeEditorApi, participant: NoteHostParticipant) {
  const unregister = noteHostCoordinator.register(participant);
  registerNoteEditor(participant.noteId, participant.api, participant.windowId);
  const releaseBridge = retainBlockBridge();
  const crepe = base.getCrepe();
  if (crepe && base.configureBlockActions) {
    const service = createBlockTransferService({
      listNotes, readNote,
      withLockedNotes: (ids, task) => noteHostCoordinator.withLockedNotes(ids, task),
      flushPendingSaves: ids => noteHostCoordinator.flushPendingSaves(ids),
      invalidateNotes: ids => noteHostCoordinator.invalidateNotes(ids),
      refreshNotes: ids => noteHostCoordinator.refreshNotes(ids),
    }, crepe.editor.action(createBlockTransferCodec), (command, args) => noteHostCoordinator.invoke(command, args));
    base.configureBlockActions({
      getFullMarkdown: () => participant.api.getFullDocument().markdown,
      isDocumentWindowed: () => participant.api.isDocumentWindowed?.() === true,
      flushPendingSave: () => participant.api.flushPendingSave!(), transferService: service,
      requestLayoutCapability: async () => {
        if (!await confirm('启用分栏后，此笔记需要支持分栏格式的版本才能编辑。是否启用？', { title: '启用分栏', kind: 'info' })) return null;
        return noteHostCoordinator.withLockedNotes([participant.noteId], async () => {
          await noteHostCoordinator.flushPendingSaves([participant.noteId]);
          const current = await readNote(participant.noteId);
          const format = await noteHostCoordinator.invoke<NoteFormatStatus>('notes_enable_columns', { noteId: participant.noteId, expectedUpdatedAt: current.updatedAt });
          formats.set(participant.noteId, format);
          noteHostCoordinator.invalidateNotes([participant.noteId]);
          await noteHostCoordinator.refreshNotes([participant.noteId]);
          return applyNoteFormat(base, format);
        });
      },
    });
  }
  return () => {
    base.configureBlockActions?.(null);
    unregister();
    unregisterNoteEditor(participant.noteId, participant.api, participant.windowId);
    releaseBridge();
  };
}
