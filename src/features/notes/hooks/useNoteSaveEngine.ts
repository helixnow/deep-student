import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/prose/view';
import type { CrepeEditorApi } from '@/components/crepe';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { dstu } from '@/dstu';
import { addTypedEventListener } from '@/events';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { registerContentDirtyChecker, type ContentSaveState } from '@/features/workbench/apps/content/contentDirtyRegistry';
import { mergeExpandedMarkdown } from '../markdownWindow';
import { assertNoteContentSize, fullDocumentRecoveryStore, type FullDocumentApi, type RetainedNoteDraft } from '../fullDocument';
import { noteHostCoordinator } from '../noteHostCoordinator';
import { saveReviewAs } from '../noteReviewHost';
import { deleteNoteDraft, loadNoteDrafts, newDurableDraft, persistNoteDraft, type DurableNoteDraft } from '../noteDraftPersistence';
import { refreshWikilinkNotesCache } from '../wikilinkNotesCache';
import { syncInlineCardsForNote } from '../inlineCards/inlineCardSyncService';

export const AUTO_SAVE_DEBOUNCE_MS = 1500;
export const INLINE_CARD_SYNC_DEBOUNCE_MS = 1200;
export const SAVING_INDICATOR_DELAY_MS = 400;

const MAX_DRAFT_ENTRIES = 10;
let nextDocumentRevision = 0;

export type NoteSaveStatus = 'saved' | 'saving' | 'unsaved' | 'failed' | 'conflict';

export type PendingSavePayload = {
  noteId: string;
  content: string;
  fullContent?: string;
  wasWindowed?: boolean;
};

/** 字数统计：非空白字符数（中文场景下与用户"字数"心智一致） */
export const countNoteChars = (markdown: string): number => markdown.replace(/\s/g, '').length;

export const fullMarkdownForReporting = (
  api: CrepeEditorApi | null,
  fallback: string,
  sourceMode = false,
): string | undefined => {
  if (sourceMode) return fallback;
  try { return api?.getFullMarkdown?.() ?? fallback; }
  catch { return undefined; } // An unavailable complete draft must not be presented as a prefix total.
};

export interface UseNoteSaveEngineOptions {
  noteId?: string;
  initialContent: string;
  initialTitle?: string;
  onSave?: (content: string) => Promise<void>;
  readOnly: boolean;
  effectiveReadOnly: boolean;
  acrWindowId?: string;
  hostInstanceId: string;
  dirtyRegistryKey?: { typeId: string; instanceKey: string };
  onSaveStateChange?: (state: ContentSaveState) => void;
  editorApi: CrepeEditorApi | null;
  lifecycleApiRef: React.MutableRefObject<CrepeEditorApi | null>;
  editorNoteIdRef: React.MutableRefObject<string | null>;
  currentRenderedNoteRef: React.MutableRefObject<string | null>;
  programmaticUpdateRef: React.MutableRefObject<boolean>;
  dropZoneRef: React.RefObject<HTMLDivElement | null>;
  onCharCountChange: (count: number | undefined) => void;
  /** Whether the editor is currently in raw Markdown source mode (CodeMirror is authoritative). */
  sourceModeRef?: React.RefObject<boolean>;
  /** Invoked when external sync/recovery/initial-content injection updates the document. */
  onExternalContentSync?: (markdown: string) => void;
}

export function useNoteSaveEngine({
  noteId,
  initialContent,
  initialTitle,
  onSave,
  readOnly,
  effectiveReadOnly,
  acrWindowId,
  hostInstanceId,
  dirtyRegistryKey,
  onSaveStateChange,
  editorApi,
  lifecycleApiRef,
  editorNoteIdRef,
  currentRenderedNoteRef,
  programmaticUpdateRef,
  dropZoneRef,
  onCharCountChange,
  sourceModeRef,
  onExternalContentSync,
}: UseNoteSaveEngineOptions) {
  const { t } = useTranslation(['notes']);
  const onExternalContentSyncRef = useRef(onExternalContentSync);
  onExternalContentSyncRef.current = onExternalContentSync;

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inlineCardSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isUnmountedRef = useRef(false);
  const isComposingRef = useRef(false);
  const lockedNotesRef = useRef(new Set<string>());
  const invalidNotesRef = useRef(new Set<string>());
  const deletedNotesRef = useRef(new Set<string>());
  const privilegedFlushRef = useRef(false);
  const projectingFullViewRef = useRef(false);
  const projectedMarkdownRef = useRef<string | null>(null);
  const fullViewMaterializedRef = useRef(false);
  const documentRevisionRef = useRef(0);

  const bumpDocumentRevision = useCallback(() => {
    documentRevisionRef.current = ++nextDocumentRevision;
    return documentRevisionRef.current;
  }, []);

  const contentRef = useRef<string>('');
  const pendingSaveQueueRef = useRef<PendingSavePayload[]>([]);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const activeSavePayloadRef = useRef<PendingSavePayload | null>(null);
  const draftByNoteRef = useRef<Map<string, string>>(new Map());
  const lastSavedMapRef = useRef<Map<string, string>>(new Map());
  const saveByNoteRef = useRef<Map<string, (content: string) => Promise<void>>>(new Map());
  const noteIdRef = useRef<string | null>(null);
  const prevNoteIdRef = useRef<string | null>(null);
  // C1：ProseMirror 事务产生的同步“文档已变”信号（onChange 有 250ms 合并窗口）
  const unsavedDocChangeRef = useRef(false);
  const saveRetryCountRef = useRef(0);
  // ★ Y8 修复：超限提示去重（同一笔记只提示一次，保存成功后复位）
  const oversizeNotifiedRef = useRef<Set<string>>(new Set());
  /** 原文规范化结果按基线缓存：每个保存基线只解析一次 */
  const normalizedBaselineRef = useRef<{ noteId: string; raw: string; normalized: string | null } | null>(null);
  const lastInitializedNoteIdRef = useRef<string | null>(null);

  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [saveError, setSaveError] = useState<'failed' | 'conflict' | null>(null);

  const recoveryDraftsRef = useRef(fullDocumentRecoveryStore(acrWindowId));
  recoveryDraftsRef.current = fullDocumentRecoveryStore(acrWindowId);
  const [recoveryDraft, setRecoveryDraft] = useState<(RetainedNoteDraft & { noteId: string }) | null>(null);
  const [recoveredDrafts, setRecoveredDrafts] = useState<DurableNoteDraft[]>([]);
  const [draftPersistenceError, setDraftPersistenceError] = useState<string | null>(null);

  const noteTitleRef = useRef<string>('');
  noteTitleRef.current = initialTitle ?? '';

  useEffect(() => {
    onSaveStateChange?.(isSaving ? 'saving' : saveError ?? (isDirty ? 'dirty' : 'saved'));
  }, [isDirty, isSaving, saveError, onSaveStateChange]);

  const cancelDebounce = useCallback(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    if (inlineCardSyncTimerRef.current) { clearTimeout(inlineCardSyncTimerRef.current); inlineCardSyncTimerRef.current = null; }
  }, []);

  const retainFailedDraft = useCallback(
    (targetNoteId: string, markdown: string, error: unknown, previousMarkdown?: string) => {
      const entry = newDurableDraft(
        markdown,
        error instanceof Error ? error.message : String(error),
        previousMarkdown,
        acrWindowId ?? hostInstanceId,
        recoveryDraftsRef.current.get(targetNoteId),
      );
      recoveryDraftsRef.current.set(targetNoteId, entry);
      void persistNoteDraft(targetNoteId, entry).catch((failure) => {
        if (!isUnmountedRef.current && currentRenderedNoteRef.current === targetNoteId) {
          setDraftPersistenceError(String(failure));
        }
      });
      if (!isUnmountedRef.current && currentRenderedNoteRef.current === targetNoteId) {
        setRecoveryDraft({ noteId: targetNoteId, ...entry });
      }
    },
    [acrWindowId, hostInstanceId, currentRenderedNoteRef],
  );

  // Keep each note bound to the save callback that owns its original path.
  useLayoutEffect(() => {
    if (noteId && onSave) saveByNoteRef.current.set(noteId, onSave);
  }, [noteId, onSave]);

  useEffect(() => { noteIdRef.current = noteId ?? null; }, [noteId]);

  useEffect(() => {
    const retained = noteId ? recoveryDraftsRef.current.get(noteId) : undefined;
    setRecoveryDraft(retained && noteId ? { noteId, ...retained } : null);
  }, [noteId]);

  useEffect(() => {
    let cancelled = false;
    setRecoveredDrafts([]);
    setDraftPersistenceError(null);
    if (noteId) {
      void loadNoteDrafts(noteId)
        .then((drafts) => { if (!cancelled) setRecoveredDrafts(drafts); })
        .catch((error) => { if (!cancelled) setDraftPersistenceError(String(error)); });
    }
    return () => { cancelled = true; };
  }, [noteId]);

  const executeSave = useCallback(
    async ({ noteId: targetNoteId, content, fullContent, wasWindowed }: PendingSavePayload) => {
      if (deletedNotesRef.current.has(targetNoteId)) {
        return;
      }
      if (invalidNotesRef.current.has(targetNoteId)) {
        throw Object.assign(new Error(t('notes:host.stale_draft_blocked', '笔记等待刷新，已阻止过期草稿保存。')), { isNonRetryable: true });
      }
      if (readOnly) return;
      // ★ Y8 修复：前端预检内容大小，与后端 1MB 限制对齐。
      try {
        assertNoteContentSize(fullContent ?? content);
      } catch (error) {
        retainFailedDraft(targetNoteId, fullContent ?? content, error);
        if (!oversizeNotifiedRef.current.has(targetNoteId)) {
          oversizeNotifiedRef.current.add(targetNoteId);
          showGlobalNotification('error', t('notes:actions.content_too_large'));
        }
        throw error;
      }

      const saveTarget = saveByNoteRef.current.get(targetNoteId);
      if (!saveTarget) {
        console.warn('[NotesCrepeEditor] DSTU save target is no longer available', { targetNoteId });
        throw Object.assign(new Error('stale_note_payload'), { isNonRetryable: true });
      }
      await saveTarget(content);

      oversizeNotifiedRef.current.delete(targetNoteId);
      const retained = recoveryDraftsRef.current.get(targetNoteId) as DurableNoteDraft | undefined;
      if (retained?.markdown === (fullContent ?? content)) {
        if (retained.persistenceId) {
          void deleteNoteDraft(targetNoteId, retained).catch((error) => {
            if (!isUnmountedRef.current) setDraftPersistenceError(String(error));
          });
        }
        recoveryDraftsRef.current.delete(targetNoteId);
        if (!isUnmountedRef.current && currentRenderedNoteRef.current === targetNoteId) setRecoveryDraft(null);
      }

      // ★ A6-18：仅当笔记仍被跟踪时回写快照，避免长会话内存无界增长。
      const liveApi = lifecycleApiRef.current;
      const savedContent =
        wasWindowed && fullContent !== undefined && targetNoteId === editorNoteIdRef.current && liveApi?.isDocumentWindowed?.() === false
          ? (liveApi.normalizeMarkdown?.(fullContent) ?? fullContent)
          : content;
      if (draftByNoteRef.current.has(targetNoteId) || targetNoteId === noteIdRef.current) {
        lastSavedMapRef.current.set(targetNoteId, savedContent);
      } else {
        lastSavedMapRef.current.delete(targetNoteId);
      }
      if (!isUnmountedRef.current && targetNoteId === noteIdRef.current) {
        setLastSaved(new Date());
        setSaveError(null);
        const draft = draftByNoteRef.current.get(targetNoteId);
        setIsDirty(unsavedDocChangeRef.current || (typeof draft === 'string' && draft !== savedContent));
      }
    },
    [readOnly, t, retainFailedDraft, currentRenderedNoteRef, lifecycleApiRef, editorNoteIdRef],
  );

  const runPendingSave = useCallback(() => {
    if (inFlightSaveRef.current) return inFlightSaveRef.current;
    if (pendingSaveQueueRef.current.length === 0) return Promise.resolve();

    if (!savingTimerRef.current) {
      savingTimerRef.current = setTimeout(() => {
        if (!isUnmountedRef.current) setIsSaving(true);
      }, SAVING_INDICATOR_DELAY_MS);
    }

    // One shared promise drains every payload queued while a save is in flight.
    const promise = (async () => {
      const terminalErrorsByNote = new Map<string, unknown>();
      try {
        let payload = pendingSaveQueueRef.current.shift() ?? null;
        while (payload) {
          activeSavePayloadRef.current = payload;
          try {
            await executeSave(payload);
            saveRetryCountRef.current = 0;
            terminalErrorsByNote.delete(payload.noteId);
          } catch (error) {
            retainFailedDraft(payload.noteId, payload.fullContent ?? payload.content, error);
            const flagged = error as Error & { isNoteConflict?: boolean; isNonRetryable?: boolean };
            if (flagged?.isNoteConflict || flagged?.isNonRetryable) {
              console.warn('[NotesCrepeEditor] ⚠️ 保存已放弃（冲突或不可重试）:', error);
              saveRetryCountRef.current = 0;
              if (!isUnmountedRef.current && payload.noteId === noteIdRef.current) {
                setSaveError(flagged?.isNoteConflict ? 'conflict' : 'failed');
              }
              terminalErrorsByNote.set(payload.noteId, error);
            } else {
              console.error('[NotesCrepeEditor] ❌ 自动保存失败', error);
              const MAX_RETRIES = 5;
              if (saveRetryCountRef.current < MAX_RETRIES) {
                pendingSaveQueueRef.current.unshift(payload);
                saveRetryCountRef.current++;
                const backoffMs = Math.min(1000 * Math.pow(2, saveRetryCountRef.current - 1), 16000);
                await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
              } else {
                console.error('[NotesCrepeEditor] ❌ 自动保存达到最大重试次数，放弃重试');
                saveRetryCountRef.current = 0;
                if (!isUnmountedRef.current && payload.noteId === noteIdRef.current) setSaveError('failed');
                showGlobalNotification('error', t('notes:actions.auto_save_failed'));
                terminalErrorsByNote.set(payload.noteId, error);
              }
            }
          }
          activeSavePayloadRef.current = null;
          payload = pendingSaveQueueRef.current.shift() ?? null;
        }
        if (terminalErrorsByNote.size > 0) throw terminalErrorsByNote.values().next().value;
      } finally {
        activeSavePayloadRef.current = null;
        inFlightSaveRef.current = null;
        if (savingTimerRef.current) { clearTimeout(savingTimerRef.current); savingTimerRef.current = null; }
        if (!isUnmountedRef.current) setIsSaving(false);
      }
    })();
    inFlightSaveRef.current = promise;
    return promise;
  }, [executeSave, t, retainFailedDraft]);

  const queueSave = useCallback(
    (content: string, overrideNoteId?: string | null) => {
      const resolvedNoteId = overrideNoteId ?? noteIdRef.current;
      if (!resolvedNoteId) return Promise.resolve();
      if (deletedNotesRef.current.has(resolvedNoteId)) {
        return Promise.resolve();
      }
      if (invalidNotesRef.current.has(resolvedNoteId) || (lockedNotesRef.current.has(resolvedNoteId) && !privilegedFlushRef.current)) {
        return Promise.reject(Object.assign(new Error(t('notes:host.operation_pending', '笔记操作尚未完成，请刷新后重试保存。')), { isNonRetryable: true }));
      }
      draftByNoteRef.current.set(resolvedNoteId, content);
      const lastSavedSnapshot = lastSavedMapRef.current.get(resolvedNoteId) ?? '';
      if (!isUnmountedRef.current && resolvedNoteId === noteIdRef.current) {
        setIsDirty(unsavedDocChangeRef.current || lastSavedSnapshot !== content);
      }

      const queuedTarget = [...pendingSaveQueueRef.current].reverse().find((item) => item.noteId === resolvedNoteId);
      const activeTarget = activeSavePayloadRef.current?.noteId === resolvedNoteId ? activeSavePayloadRef.current : null;
      const pipelineTarget = queuedTarget?.content ?? activeTarget?.content ?? lastSavedSnapshot;
      if (pipelineTarget === content) return runPendingSave();

      pendingSaveQueueRef.current = pendingSaveQueueRef.current.filter((item) => item.noteId !== resolvedNoteId);
      const liveApi = lifecycleApiRef.current;
      const inSourceMode = Boolean(sourceModeRef?.current && resolvedNoteId === noteIdRef.current);
      let fullContent = content;
      let wasWindowed = false;
      try {
        if (!isUnmountedRef.current && !inSourceMode && editorNoteIdRef.current === resolvedNoteId && currentRenderedNoteRef.current === resolvedNoteId) {
          wasWindowed = liveApi?.isDocumentWindowed?.() === true;
          if (wasWindowed && liveApi) {
            fullContent = mergeExpandedMarkdown(liveApi.getMarkdown(), content, liveApi.getFullMarkdown?.() ?? content);
          }
        }
      } catch (error) {
        retainFailedDraft(resolvedNoteId, content, error);
        if (!isUnmountedRef.current && currentRenderedNoteRef.current === resolvedNoteId) setSaveError('failed');
        return Promise.reject(error);
      }
      pendingSaveQueueRef.current.push({ noteId: resolvedNoteId, content, fullContent, wasWindowed });
      return runPendingSave();
    },
    [runPendingSave, retainFailedDraft, t, lifecycleApiRef, editorNoteIdRef, currentRenderedNoteRef, sourceModeRef],
  );

  const flushInlineCardSync = useCallback(
    (targetNoteId?: string | null, fallbackMarkdown?: string) => {
      const resolvedNoteId = targetNoteId ?? noteIdRef.current;
      if (!resolvedNoteId || readOnly || isComposingRef.current) return;
      const inSourceMode = Boolean(sourceModeRef?.current && resolvedNoteId === noteIdRef.current);
      if (inSourceMode) {
        const markdown = fallbackMarkdown ?? draftByNoteRef.current.get(resolvedNoteId) ?? contentRef.current;
        void syncInlineCardsForNote({ noteId: resolvedNoteId, noteTitle: noteTitleRef.current || undefined, doc: null, markdown }).catch(() => {});
        return;
      }
      const liveApi = editorNoteIdRef.current === resolvedNoteId ? lifecycleApiRef.current : null;
      let liveView: EditorView | null = null;
      try { liveView = liveApi?.getCrepe?.()?.editor.ctx.get(editorViewCtx) ?? null; }
      catch { liveView = null; }
      if (liveView?.composing) return;
      const doc = liveView && !liveView.isDestroyed ? liveView.state.doc : null;
      const markdown = !doc ? (fallbackMarkdown ?? draftByNoteRef.current.get(resolvedNoteId) ?? contentRef.current) : undefined;
      void syncInlineCardsForNote({ noteId: resolvedNoteId, noteTitle: noteTitleRef.current || undefined, doc, markdown }).catch(() => {});
    },
    [readOnly, editorNoteIdRef, lifecycleApiRef, sourceModeRef],
  );

  const flushNoteDraft = useCallback(
    (targetNoteId?: string | null) => {
      const resolvedNoteId = targetNoteId ?? noteIdRef.current;
      if (!resolvedNoteId) return Promise.resolve();
      if (deletedNotesRef.current.has(resolvedNoteId)) {
        cancelDebounce();
        return Promise.resolve();
      }
      cancelDebounce();
      const inSourceMode = Boolean(sourceModeRef?.current && resolvedNoteId === noteIdRef.current);
      const api = lifecycleApiRef.current;
      const draft = inSourceMode
        ? (draftByNoteRef.current.get(resolvedNoteId) ?? contentRef.current)
        : editorNoteIdRef.current === resolvedNoteId && api?.getCrepe()
          ? api.getMarkdown()
          : draftByNoteRef.current.get(resolvedNoteId);
      flushInlineCardSync(resolvedNoteId, typeof draft === 'string' ? draft : undefined);
      if (typeof draft !== 'string') return Promise.resolve();
      unsavedDocChangeRef.current = false;
      return queueSave(draft, resolvedNoteId);
    },
    [cancelDebounce, queueSave, flushInlineCardSync, lifecycleApiRef, editorNoteIdRef, sourceModeRef],
  );

  const flushNoteDraftRef = useRef(flushNoteDraft);
  flushNoteDraftRef.current = flushNoteDraft;

  // 切换笔记时保存草稿 & 清理旧条目防止内存泄漏
  useEffect(() => {
    const prevId = prevNoteIdRef.current;
    if (prevId && prevId !== noteId) {
      const prevDraft = draftByNoteRef.current.get(prevId);
      if (typeof prevDraft === 'string') {
        queueSave(prevDraft, prevId)
          .catch(() => {})
          .finally(() => { if (noteIdRef.current !== prevId) saveByNoteRef.current.delete(prevId); });
      } else {
        saveByNoteRef.current.delete(prevId);
      }
      draftByNoteRef.current.delete(prevId);
      lastSavedMapRef.current.delete(prevId);
    }
    if (draftByNoteRef.current.size > MAX_DRAFT_ENTRIES) {
      const firstKey = draftByNoteRef.current.keys().next().value;
      if (firstKey && firstKey !== noteId) {
        draftByNoteRef.current.delete(firstKey);
        lastSavedMapRef.current.delete(firstKey);
      }
    }
    prevNoteIdRef.current = noteId ?? null;
  }, [noteId, queueSave]);

  // 重置内容引用：只在 noteId 真正变化时才重置 draftByNoteRef 和 lastSavedMapRef
  useEffect(() => {
    const isNewNote = noteId !== lastInitializedNoteIdRef.current;
    if (isNewNote) {
      cancelDebounce();
      programmaticUpdateRef.current = false;
      unsavedDocChangeRef.current = false;
      contentRef.current = initialContent;
    }

    if (noteId && isNewNote) {
      const existingDraft = draftByNoteRef.current.get(noteId);
      if (existingDraft !== undefined) {
        lastSavedMapRef.current.set(noteId, initialContent || '');
      } else {
        draftByNoteRef.current.set(noteId, initialContent || '');
        lastSavedMapRef.current.set(noteId, initialContent || '');
      }
      lastInitializedNoteIdRef.current = noteId;
    } else if (noteId && !isNewNote) {
      const currentDraft = draftByNoteRef.current.get(noteId);
      const isDraftEmpty =
        currentDraft === undefined ||
        (currentDraft === '' && lastSavedMapRef.current.get(noteId) === '' && !unsavedDocChangeRef.current);
      if (isDraftEmpty && initialContent.length > 0) {
        contentRef.current = initialContent;
        draftByNoteRef.current.set(noteId, initialContent);
        lastSavedMapRef.current.set(noteId, initialContent);
        onExternalContentSyncRef.current?.(initialContent);
      }
    }

    // ★ F2 修复：lastSaved 只在切换笔记时复位。
    if (isNewNote) {
      setLastSaved(null);
      setSaveError(null);
      if (noteId) {
        const draft = draftByNoteRef.current.get(noteId);
        const saved = lastSavedMapRef.current.get(noteId) ?? '';
        setIsDirty(typeof draft === 'string' && draft !== saved);
      } else {
        setIsDirty(false);
      }
    }
  }, [initialContent, noteId, cancelDebounce, programmaticUpdateRef]);

  const handleManualSave = useCallback(async () => {
    if (effectiveReadOnly) return;
    setSaveError(null);
    await flushNoteDraft();
  }, [flushNoteDraft, effectiveReadOnly]);

  const saveStatus: NoteSaveStatus = isSaving
    ? 'saving'
    : saveError === 'conflict'
      ? 'conflict'
      : saveError === 'failed'
        ? 'failed'
        : isDirty
          ? 'unsaved'
          : 'saved';

  const isPureReserialization = useCallback((targetNoteId: string, raw: string, markdown: string): boolean => {
    const api = lifecycleApiRef.current;
    if (!api?.normalizeMarkdown || !raw) return false;
    let cached = normalizedBaselineRef.current;
    if (!cached || cached.noteId !== targetNoteId || cached.raw !== raw) {
      let normalized: string | null = null;
      try { normalized = api.normalizeMarkdown(raw); } catch { normalized = null; }
      cached = { noteId: targetNoteId, raw, normalized };
      normalizedBaselineRef.current = cached;
    }
    return cached.normalized !== null && cached.normalized === markdown;
  }, [lifecycleApiRef]);

  const handleChange = useCallback(
    (markdown: string) => {
      if (projectingFullViewRef.current || projectedMarkdownRef.current === markdown) return;
      projectedMarkdownRef.current = null;
      if (effectiveReadOnly) return;
      unsavedDocChangeRef.current = false;
      if (programmaticUpdateRef.current) {
        contentRef.current = markdown;
        if (noteId) {
          draftByNoteRef.current.set(noteId, markdown);
          setIsDirty(markdown !== (lastSavedMapRef.current.get(noteId) ?? ''));
        }
        const full = fullMarkdownForReporting(lifecycleApiRef.current, markdown, Boolean(sourceModeRef?.current));
        onCharCountChange(full === undefined ? undefined : countNoteChars(full));
        return;
      }
      contentRef.current = markdown;
      if (noteId) {
        draftByNoteRef.current.set(noteId, markdown);
        const lastSavedSnapshot = lastSavedMapRef.current.get(noteId) ?? '';
        // 打开即改写防护：编辑器把磁盘原文重新序列化不算用户修改（源码模式下为字面编辑，不适用）。
        if (!sourceModeRef?.current && markdown !== lastSavedSnapshot && isPureReserialization(noteId, lastSavedSnapshot, markdown)) {
          lastSavedMapRef.current.set(noteId, markdown);
          setIsDirty(false);
          return;
        }
        setIsDirty(markdown !== lastSavedSnapshot);
      }
      if (sourceModeRef?.current) {
        onCharCountChange(countNoteChars(markdown));
      }
      cancelDebounce();
      saveTimerRef.current = setTimeout(() => { queueSave(markdown, noteId).catch(() => {}); }, AUTO_SAVE_DEBOUNCE_MS);
      if (isComposingRef.current) return;

      if (contentChangedTimerRef.current) clearTimeout(contentChangedTimerRef.current);
      const eventNoteId = noteId;
      contentChangedTimerRef.current = setTimeout(() => {
        if (isUnmountedRef.current || currentRenderedNoteRef.current !== eventNoteId) return;
        const fullMarkdown = fullMarkdownForReporting(lifecycleApiRef.current, markdown, Boolean(sourceModeRef?.current));
        onCharCountChange(fullMarkdown === undefined ? undefined : countNoteChars(fullMarkdown));
        if (fullMarkdown !== undefined) {
          window.dispatchEvent(new CustomEvent('notes:content-changed', { detail: { noteId: eventNoteId, content: fullMarkdown } }));
        }
      }, 500);

      if (eventNoteId) {
        inlineCardSyncTimerRef.current = setTimeout(() => {
          if (isUnmountedRef.current || isComposingRef.current || currentRenderedNoteRef.current !== eventNoteId) return;
          flushInlineCardSync(eventNoteId, markdown);
        }, INLINE_CARD_SYNC_DEBOUNCE_MS);
      }
    },
    [noteId, queueSave, effectiveReadOnly, isPureReserialization, flushInlineCardSync, cancelDebounce, programmaticUpdateRef, lifecycleApiRef, currentRenderedNoteRef, onCharCountChange, sourceModeRef],
  );

  // C1：事务级同步通知（无需等待 250ms onChange）
  const handleDocumentChange = useCallback(() => {
    if (projectingFullViewRef.current) return;
    projectedMarkdownRef.current = null;
    bumpDocumentRevision();
    if (effectiveReadOnly) return;
    unsavedDocChangeRef.current = true;
    if (!isUnmountedRef.current) setIsDirty(true);
  }, [effectiveReadOnly, bumpDocumentRevision]);

  // Snapshot before the child editor's passive cleanup destroys its view.
  useLayoutEffect(() => () => { if (noteId) void flushNoteDraftRef.current(noteId).catch(() => {}); }, [noteId]);

  // 卸载清理
  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      cancelDebounce();
      if (savingTimerRef.current) { clearTimeout(savingTimerRef.current); savingTimerRef.current = null; }
      if (contentChangedTimerRef.current) { clearTimeout(contentChangedTimerRef.current); contentChangedTimerRef.current = null; }
      flushNoteDraftRef.current()?.catch(() => {});
    };
  }, [cancelDebounce]);

  // 监听 IME composition 事件，在合成期间跳过实时事件派发
  useEffect(() => {
    const container = dropZoneRef.current;
    if (!container) return;
    const handleCompositionStart = () => {
      isComposingRef.current = true;
      if (inlineCardSyncTimerRef.current) { clearTimeout(inlineCardSyncTimerRef.current); inlineCardSyncTimerRef.current = null; }
    };
    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      const currentNoteId = noteIdRef.current;
      if (currentNoteId && !readOnly) {
        if (inlineCardSyncTimerRef.current) clearTimeout(inlineCardSyncTimerRef.current);
        inlineCardSyncTimerRef.current = setTimeout(() => {
          if (isUnmountedRef.current || isComposingRef.current || currentRenderedNoteRef.current !== currentNoteId) return;
          flushInlineCardSync(currentNoteId);
        }, INLINE_CARD_SYNC_DEBOUNCE_MS);
      }
    };
    container.addEventListener('compositionstart', handleCompositionStart, { capture: true });
    container.addEventListener('compositionend', handleCompositionEnd, { capture: true });
    return () => {
      container.removeEventListener('compositionstart', handleCompositionStart, { capture: true });
      container.removeEventListener('compositionend', handleCompositionEnd, { capture: true });
    };
  }, [dropZoneRef, readOnly, flushInlineCardSync, currentRenderedNoteRef]);

  // 监听 canvas:content-changed 事件
  useEffect(() => {
    return addTypedEventListener<{ noteId: string; newContent?: string }>(
      'canvas:content-changed',
      ({ noteId: updatedNoteId, newContent }) => {
        const currentNoteId = noteIdRef.current;
        if (updatedNoteId !== currentNoteId || newContent === undefined || !editorApi || !currentNoteId) return;
        const draft = draftByNoteRef.current.get(currentNoteId);
        const lastSavedSnapshot = lastSavedMapRef.current.get(currentNoteId) ?? '';
        const dirty =
          unsavedDocChangeRef.current ||
          (typeof draft === 'string' && draft !== lastSavedSnapshot) ||
          pendingSaveQueueRef.current.some((p) => p.noteId === currentNoteId) ||
          inFlightSaveRef.current !== null;
        if (dirty) {
          showGlobalNotification('warning', t('notes:host.ai_update_deferred', 'AI 的更新未应用：这篇笔记有尚未保存的修改。保存后若出现冲突提示，可在其中对比并选择版本。'));
          return;
        }
        const inSourceMode = Boolean(sourceModeRef?.current);
        const previousContent = inSourceMode
          ? (draftByNoteRef.current.get(currentNoteId) ?? contentRef.current)
          : editorApi.getMarkdown();
        editorApi.setMarkdown(newContent);
        if (!inSourceMode) {
          try { editorApi.agentFlashChange?.(previousContent, newContent); } catch { /* 演出失败不影响同步 */ }
        }
        contentRef.current = newContent;
        draftByNoteRef.current.set(currentNoteId, newContent);
        lastSavedMapRef.current.set(currentNoteId, newContent);
        onCharCountChange(countNoteChars(newContent));
        onExternalContentSyncRef.current?.(newContent);
      },
    );
  }, [editorApi, t, sourceModeRef, onCharCountChange]);

  // ★ R3 修复：监听外部更新事件，原位刷新编辑器内容
  useEffect(() => {
    return addTypedEventListener<{ noteId: string; content: string; force?: boolean; windowId?: string }>(
      'notes:external-updated',
      ({ noteId: targetNoteId, content: newContent, force, windowId: targetWindowId }) => {
        const currentNoteId = noteIdRef.current;
        if (!currentNoteId || targetNoteId !== currentNoteId) return;
        if (force && targetWindowId && acrWindowId && targetWindowId !== acrWindowId) return;

        if (!force) {
          const draft = draftByNoteRef.current.get(currentNoteId);
          const lastSavedSnapshot = lastSavedMapRef.current.get(currentNoteId) ?? '';
          const dirty =
            unsavedDocChangeRef.current ||
            (typeof draft === 'string' && draft !== lastSavedSnapshot) ||
            pendingSaveQueueRef.current.some((p) => p.noteId === currentNoteId) ||
            inFlightSaveRef.current !== null;
          if (dirty) return;
        } else {
          cancelDebounce();
          pendingSaveQueueRef.current = pendingSaveQueueRef.current.filter((p) => p.noteId !== currentNoteId);
        }

        contentRef.current = newContent;
        bumpDocumentRevision();
        fullViewMaterializedRef.current = false;
        draftByNoteRef.current.set(currentNoteId, newContent);
        lastSavedMapRef.current.set(currentNoteId, newContent);

        const inSourceMode = Boolean(sourceModeRef?.current);
        if (editorApi) {
          if (inSourceMode) {
            try { editorApi.setMarkdown(newContent); } catch { /* ignore hidden editor sync errors */ }
          } else if (editorApi.getMarkdown() !== newContent) {
            const previousContent = editorApi.getMarkdown();
            editorApi.setMarkdown(newContent);
            try { editorApi.agentFlashChange?.(previousContent, newContent); } catch { /* 演出失败不影响同步 */ }
          }
        }
        unsavedDocChangeRef.current = false;
        const fullMarkdown = fullMarkdownForReporting(editorApi, newContent, inSourceMode);
        onCharCountChange(fullMarkdown === undefined ? undefined : countNoteChars(fullMarkdown));
        onExternalContentSyncRef.current?.(fullMarkdown ?? newContent);
        if (fullMarkdown !== undefined) {
          window.dispatchEvent(new CustomEvent('notes:content-changed', { detail: { noteId: currentNoteId, content: fullMarkdown } }));
        }
        setLastSaved(new Date());
        if (!isUnmountedRef.current) { setSaveError(null); setIsDirty(false); }
      },
    );
  }, [editorApi, acrWindowId, cancelDebounce, bumpDocumentRevision, onCharCountChange, sourceModeRef]);

  // ★ F1 修复：显式保存请求（冲突恢复"恢复我的版本"等场景）
  useEffect(() => {
    return addTypedEventListener<{ noteId: string; content: string; windowId?: string }>(
      'notes:request-save',
      ({ noteId: targetNoteId, content, windowId: targetWindowId }) => {
        if (!targetNoteId || targetNoteId !== noteIdRef.current) return;
        if (targetWindowId && acrWindowId && targetWindowId !== acrWindowId) return;
        contentRef.current = content;
        draftByNoteRef.current.set(targetNoteId, content);
        pendingSaveQueueRef.current = pendingSaveQueueRef.current.filter((p) => p.noteId !== targetNoteId);
        pendingSaveQueueRef.current.push({ noteId: targetNoteId, content });
        runPendingSave().catch(() => {});
      },
    );
  }, [runPendingSave, acrWindowId]);

  // 窗口隐藏时立即冲刷待保存草稿
  useEventRegistry(
    [
      {
        target: 'document',
        type: 'visibilitychange',
        listener: () => {
          if (document.visibilityState !== 'hidden') return;
          cancelDebounce();
          flushNoteDraftRef.current()?.catch(() => {});
        },
      },
    ],
    [cancelDebounce],
  );

  // beforeunload：检查所有笔记的草稿/保存队列
  useEventRegistry(
    [
      {
        target: 'window',
        type: 'beforeunload',
        listener: (rawEvent) => {
          const event = rawEvent as BeforeUnloadEvent;
          let hasPending = pendingSaveQueueRef.current.length > 0 || inFlightSaveRef.current !== null;
          const liveApi = lifecycleApiRef.current;
          const liveNoteId = editorNoteIdRef.current;
          if (!hasPending && !sourceModeRef?.current && liveNoteId && liveApi?.getCrepe()) {
            hasPending = liveApi.getMarkdown() !== (lastSavedMapRef.current.get(liveNoteId) ?? '');
          }
          if (!hasPending) {
            for (const [id, draft] of draftByNoteRef.current) {
              if (draft !== (lastSavedMapRef.current.get(id) ?? '')) { hasPending = true; break; }
            }
          }
          if (hasPending) { event.preventDefault(); event.returnValue = ''; }
        },
      },
    ],
    [lifecycleApiRef, editorNoteIdRef, sourceModeRef],
  );

  const isCurrentNoteDirty = useCallback(() => {
    const currentNoteId = noteIdRef.current;
    if (!currentNoteId || deletedNotesRef.current.has(currentNoteId)) return false;
    const draft = draftByNoteRef.current.get(currentNoteId);
    const lastSavedSnapshot = lastSavedMapRef.current.get(currentNoteId) ?? '';
    return (
      unsavedDocChangeRef.current ||
      (typeof draft === 'string' && draft !== lastSavedSnapshot) ||
      pendingSaveQueueRef.current.some((payload) => payload.noteId === currentNoteId) ||
      inFlightSaveRef.current !== null
    );
  }, []);

  // ACR R1-13：把真实 isDirty 接入 contentDirtyRegistry
  const dirtyTypeId = dirtyRegistryKey?.typeId;
  const dirtyInstanceKey = dirtyRegistryKey?.instanceKey;
  useEffect(() => {
    if (!dirtyTypeId || !dirtyInstanceKey) return;
    return registerContentDirtyChecker(dirtyTypeId, dirtyInstanceKey, isCurrentNoteDirty);
  }, [dirtyTypeId, dirtyInstanceKey, isCurrentNoteDirty]);

  const copyRecoveryDraft = useCallback(async (previous = false) => {
    if (!recoveryDraft) return;
    const markdown = previous ? recoveryDraft.previousMarkdown : recoveryDraft.markdown;
    if (markdown !== undefined && !(await copyTextToClipboard(markdown))) {
      showGlobalNotification('error', t('notes:fullDocument.errors.copy_failed'));
    }
  }, [recoveryDraft, t]);

  const restoreRecoveryDraft = useCallback(async (previous = false) => {
    if (!recoveryDraft || !editorApi || effectiveReadOnly) return;
    const markdown = previous ? recoveryDraft.previousMarkdown : recoveryDraft.markdown;
    if (markdown === undefined) return;
    try {
      const api = editorApi as FullDocumentApi;
      const baseline = api.getFullDocument();
      if (baseline.noteId !== recoveryDraft.noteId) return;
      const restored = await api.replaceFullDocument(markdown, baseline);
      const syncedMarkdown = restored?.markdown ?? markdown;
      contentRef.current = syncedMarkdown;
      draftByNoteRef.current.set(baseline.noteId, syncedMarkdown);
      onExternalContentSyncRef.current?.(syncedMarkdown);
      recoveryDraftsRef.current.delete(baseline.noteId);
      setRecoveryDraft(null);
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : String(error));
    }
  }, [recoveryDraft, editorApi, effectiveReadOnly]);

  const discardRecoveryDraft = useCallback(async () => {
    if (!recoveryDraft) return;
    try {
      const durable = recoveryDraft as DurableNoteDraft & { noteId: string };
      if (durable.persistenceId) await deleteNoteDraft(durable.noteId, durable);
      recoveryDraftsRef.current.delete(recoveryDraft.noteId);
      setRecoveredDrafts((drafts) => drafts.filter((draft) => draft.persistenceId !== durable.persistenceId));
      setRecoveryDraft(null);
    } catch (error) { setDraftPersistenceError(String(error)); }
  }, [recoveryDraft]);

  const saveRecoveryAs = useCallback(async () => {
    if (!recoveryDraft) return;
    const draft = recoveryDraft as DurableNoteDraft & { noteId: string };
    try {
      await saveReviewAs(
        draft.markdown,
        `draft-copy:${draft.persistenceId ?? hostInstanceId}:${draft.persistenceRevision ?? 0}`,
        draft.noteId,
        initialTitle ?? t('notes:host.recovered_draft_title', '恢复草稿'),
        undefined,
        noteHostCoordinator.getLeaseAuth(draft.noteId),
      );
      await refreshWikilinkNotesCache();
      showGlobalNotification('success', t('notes:host.draft_saved_as_note', '草稿已另存为笔记。'));
    } catch (error) { showGlobalNotification('error', String(error)); }
  }, [recoveryDraft, hostInstanceId, initialTitle, t]);

  const retryDraftPersistence = useCallback(() => {
    const draft = noteId ? (recoveryDraftsRef.current.get(noteId) as DurableNoteDraft | undefined) : undefined;
    if (noteId && draft?.persistenceId) {
      void persistNoteDraft(noteId, draft).then(() => setDraftPersistenceError(null)).catch((error) => setDraftPersistenceError(String(error)));
    } else if (noteId) {
      void loadNoteDrafts(noteId).then((drafts) => { setRecoveredDrafts(drafts); setDraftPersistenceError(null); }).catch((error) => setDraftPersistenceError(String(error)));
    }
  }, [noteId]);

  const discardDraftForDelete = useCallback((targetNoteId?: string | null) => {
    const resolvedNoteId = targetNoteId ?? noteIdRef.current;
    if (!resolvedNoteId) return;
    deletedNotesRef.current.add(resolvedNoteId);
    cancelDebounce();
    pendingSaveQueueRef.current = pendingSaveQueueRef.current.filter((item) => item.noteId !== resolvedNoteId);
    if (resolvedNoteId === noteIdRef.current) {
      unsavedDocChangeRef.current = false;
      setIsDirty(false);
    }
  }, [cancelDebounce]);

  const clearDeleteGuard = useCallback((targetNoteId?: string | null) => {
    const resolvedNoteId = targetNoteId ?? noteIdRef.current;
    if (!resolvedNoteId) return;
    deletedNotesRef.current.delete(resolvedNoteId);
    const draft = draftByNoteRef.current.get(resolvedNoteId);
    const lastSavedSnapshot = lastSavedMapRef.current.get(resolvedNoteId) ?? '';
    if (resolvedNoteId === noteIdRef.current) {
      const dirty =
        (typeof draft === 'string' && draft !== lastSavedSnapshot) ||
        pendingSaveQueueRef.current.some((payload) => payload.noteId === resolvedNoteId);
      setIsDirty(dirty);
    }
  }, []);

  useEffect(() => {
    if (!noteId) return;
    return dstu.watch('*', (event) => {
      const pathLeaf = event.path.split('/').filter(Boolean).pop() ?? '';
      const matches = event.node?.id === noteId || pathLeaf === noteId || event.path === `/${noteId}`;
      if (!matches) return;
      if (event.type === 'deleted' || event.type === 'purged') {
        cancelDebounce();
        pendingSaveQueueRef.current = pendingSaveQueueRef.current.filter((item) => item.noteId !== noteId);
        queueMicrotask(() => {
          discardDraftForDelete(noteId);
        });
      } else if (event.type === 'restored') {
        clearDeleteGuard(noteId);
      }
    });
  }, [noteId, cancelDebounce, discardDraftForDelete, clearDeleteGuard]);

  return {
    lastSaved, isSaving, isDirty, setIsDirty, saveError, setSaveError, saveStatus,
    recoveryDraft, setRecoveryDraft, recoveredDrafts, draftPersistenceError,
    saveTimerRef, contentRef, noteIdRef, pendingSaveQueueRef, inFlightSaveRef,
    draftByNoteRef, lastSavedMapRef, unsavedDocChangeRef, flushNoteDraftRef,
    isUnmountedRef, isComposingRef, lockedNotesRef, invalidNotesRef, privilegedFlushRef,
    projectingFullViewRef, projectedMarkdownRef, fullViewMaterializedRef,
    documentRevisionRef, bumpDocumentRevision,
    cancelDebounce, retainFailedDraft, queueSave, flushNoteDraft,
    discardDraftForDelete, clearDeleteGuard,
    handleManualSave, handleChange, handleDocumentChange, isCurrentNoteDirty,
    copyRecoveryDraft, restoreRecoveryDraft, discardRecoveryDraft, saveRecoveryAs, retryDraftPersistence,
  };
}
