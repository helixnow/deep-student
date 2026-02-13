/**
 * 笔记模块 Crepe 编辑器
 * 基于 @milkdown/crepe 的 Markdown 编辑器
 * 
 * 功能：
 * - 自动保存
 * - 笔记资产管理（图片上传）
 * - 与 NotesContext 集成
 * - Find & Replace（待实现）
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, FilePlus, FolderPlus, ImagePlus, ExternalLink } from 'lucide-react';
import { CrepeEditor, type CrepeEditorApi } from '../crepe';
import { CustomScrollArea } from '../custom-scroll-area';
import { useNotesOptional } from './NotesContext';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { NotionButton } from '@/components/ui/NotionButton';
// TODO: Re-import Input & Separator when Find & Replace is implemented
// import { Input } from '../ui/shad/Input';
// import { Separator } from '../ui/shad/Separator';
import { NotesEditorHeader } from './components/NotesEditorHeader';
import { NotesEditorToolbar } from './components/NotesEditorToolbar';
import { emitOutlineDebugLog, emitOutlineDebugSnapshot } from '../../debug-panel/events/NotesOutlineDebugChannel';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { isMacOS } from '../../utils/platform';
import { useTauriDragAndDrop } from '../../hooks/useTauriDragAndDrop';
import { MOBILE_LAYOUT } from '../../config/mobileLayout';
import { useCanvasAIEditHandler } from './hooks/useCanvasAIEditHandler';
import { AIDiffPanel } from './AIDiffPanel';
import { ErrorBoundary } from '../ErrorBoundary';

const AUTO_SAVE_DEBOUNCE_MS = 1500;
const SAVING_INDICATOR_DELAY_MS = 400;

type PendingSavePayload = {
  noteId: string;
  content: string;
};

// ========== DSTU 模式 Props ==========
export interface NotesCrepeEditorProps {
  /** DSTU 模式：初始内容 */
  initialContent?: string;
  /** DSTU 模式：初始标题 */
  initialTitle?: string;
  /** DSTU 模式：保存回调 */
  onSave?: (content: string) => Promise<void>;
  /** DSTU 模式：标题变更回调 */
  onTitleChange?: (title: string) => Promise<void>;
  /** DSTU 模式：笔记 ID（用于事件标识） */
  noteId?: string;
  /** 是否只读 */
  readOnly?: boolean;
  /** 自定义类名 */
  className?: string;
}

export const NotesCrepeEditor: React.FC<NotesCrepeEditorProps> = ({
  initialContent,
  initialTitle,
  onSave: dstuOnSave,
  onTitleChange: dstuOnTitleChange,
  noteId: dstuNoteId,
  readOnly = false,
  className,
}) => {
  const { t } = useTranslation(['notes', 'common']);
  const { isSmallScreen } = useBreakpoint();
  
  // ========== 模式判断 ==========
  // DSTU 模式：通过 props 传入数据
  // Context 模式：通过 NotesContext 获取数据
  const isDstuMode = initialContent !== undefined;
  
  // ========== Context 获取（可选） ==========
  const notesContext = useNotesOptional();
  const contextActive = notesContext?.active;
  const saveNoteContent = notesContext?.saveNoteContent;
  const createNote = notesContext?.createNote;
  const createFolder = notesContext?.createFolder;
  const loadedContentIds = notesContext?.loadedContentIds ?? new Set<string>();
  const setEditor = notesContext?.setEditor;
  const setSidebarRevealId = notesContext?.setSidebarRevealId;

  // ========== 根据模式选择数据源 ==========
  const active = isDstuMode ? null : contextActive;

  // 判断当前笔记是否被 Portal 到白板
  // 白板功能已移除，始终为 false
  const isPortaledToCanvas = false;

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<string>('');
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [editorApi, setEditorApi] = useState<CrepeEditorApi | null>(null);
  const pendingSaveQueueRef = useRef<PendingSavePayload[]>([]);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const draftByNoteRef = useRef<Map<string, string>>(new Map());
  const lastSavedMapRef = useRef<Map<string, string>>(new Map());
  const noteIdRef = useRef<string | null>(null);
  const prevNoteIdRef = useRef<string | null>(null);
  const isUnmountedRef = useRef(false);
  const isComposingRef = useRef(false); // IME 合成状态追踪
  const contentChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 内容变化事件防抖
  const saveRetryCountRef = useRef(0); // 🔒 审计修复: 自动保存重试计数（指数退避）

  // TODO: Find & Replace state — 待 Crepe 支持后重新实现

  const dropZoneRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);

  const cancelDebounce = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  };

  // ========== 根据模式选择 noteId 和初始值 ==========
  const noteId = isDstuMode ? dstuNoteId : active?.id;
  const initialValue = isDstuMode ? initialContent : (active?.content_md || '');

  useEffect(() => {
    noteIdRef.current = noteId ?? null;
  }, [noteId]);

  // ========== 保存逻辑（支持 DSTU 模式） ==========
  const executeSave = useCallback(async ({ noteId: targetNoteId, content }: PendingSavePayload) => {
    if (readOnly) {
      return;
    }
    if (isDstuMode) {
      // DSTU 模式：调用 props 的 onSave
      if (dstuOnSave) {
        await dstuOnSave(content);
      }
    } else {
      // Context 模式：调用 NotesContext.saveNoteContent
      if (saveNoteContent) {
        await saveNoteContent(targetNoteId, content);
      }
    }
    lastSavedMapRef.current.set(targetNoteId, content);
    if (!isUnmountedRef.current && targetNoteId === noteIdRef.current) {
      setLastSaved(new Date());
    }
  }, [isDstuMode, dstuOnSave, saveNoteContent, readOnly]);

  const dequeuePending = () => {
    if (!pendingSaveQueueRef.current.length) {
      return null;
    }
    return pendingSaveQueueRef.current.shift() ?? null;
  };

  const runPendingSave = useCallback(() => {
    if (inFlightSaveRef.current) {
      return inFlightSaveRef.current;
    }
    const payload = dequeuePending();
    if (!payload) {
      return Promise.resolve();
    }

    if (!savingTimerRef.current) {
      savingTimerRef.current = setTimeout(() => {
        setIsSaving(true);
      }, SAVING_INDICATOR_DELAY_MS);
    }
    const promise = executeSave(payload)
      .then(() => {
        // 保存成功，重置重试计数
        saveRetryCountRef.current = 0;
      })
      .catch((error) => {
        console.error('[NotesCrepeEditor] ❌ 自动保存失败', error);
        // 🔒 审计修复: 添加指数退避和最大重试次数，防止保存失败时无限高频重试
        const MAX_RETRIES = 5;
        if (saveRetryCountRef.current < MAX_RETRIES) {
          pendingSaveQueueRef.current.unshift(payload);
          saveRetryCountRef.current++;
        } else {
          console.error('[NotesCrepeEditor] ❌ 自动保存达到最大重试次数，放弃重试');
          saveRetryCountRef.current = 0;
          // [S-001] 修复：通知用户保存失败，建议手动操作
          showGlobalNotification(
            'error',
            t('notes:actions.auto_save_failed', '笔记自动保存失败，请尝试手动保存（Ctrl+S）或复制内容到安全位置。')
          );
        }
        throw error;
      })
      .finally(() => {
        inFlightSaveRef.current = null;
        if (savingTimerRef.current) {
          clearTimeout(savingTimerRef.current);
          savingTimerRef.current = null;
        }
        setIsSaving(false);
        if (pendingSaveQueueRef.current.length > 0 && !isUnmountedRef.current) {
          // 🔒 审计修复 + 审阅修复: 仅在有重试计数时才延迟（成功后的新保存立即执行）
          if (saveRetryCountRef.current > 0) {
            // 指数退避延迟（1s, 2s, 4s, 8s, 16s）
            const backoffMs = Math.min(1000 * Math.pow(2, saveRetryCountRef.current - 1), 16000);
            setTimeout(() => {
              if (!isUnmountedRef.current) {
                void runPendingSave();
              }
            }, backoffMs);
          } else {
            // 成功后的正常排队保存，立即执行
            void runPendingSave();
          }
        }
      });
    inFlightSaveRef.current = promise;
    return promise;
  }, [executeSave]);

  const queueSave = useCallback((content: string, overrideNoteId?: string | null) => {
    const resolvedNoteId = overrideNoteId ?? noteIdRef.current;
    if (!resolvedNoteId) {
      return Promise.resolve();
    }
    draftByNoteRef.current.set(resolvedNoteId, content);
    const lastSavedSnapshot = lastSavedMapRef.current.get(resolvedNoteId) ?? '';
    
    if (lastSavedSnapshot === content) {
      return Promise.resolve();
    }
    
    pendingSaveQueueRef.current = pendingSaveQueueRef.current.filter((item) => item.noteId !== resolvedNoteId);
    pendingSaveQueueRef.current.push({ noteId: resolvedNoteId, content });
    return runPendingSave();
  }, [runPendingSave]);

  const flushNoteDraft = useCallback((targetNoteId?: string | null) => {
    const resolvedNoteId = targetNoteId ?? noteIdRef.current;
    if (!resolvedNoteId) {
      return Promise.resolve();
    }
    cancelDebounce();
    const draft = draftByNoteRef.current.get(resolvedNoteId);
    if (typeof draft !== 'string') {
      return Promise.resolve();
    }
    return queueSave(draft, resolvedNoteId);
  }, [queueSave]);

  // 切换笔记时保存草稿 & 清理旧条目防止内存泄漏
  const MAX_DRAFT_ENTRIES = 10;
  useEffect(() => {
    const prevId = prevNoteIdRef.current;
    if (prevId && prevId !== noteId) {
      const prevDraft = draftByNoteRef.current.get(prevId);
      if (typeof prevDraft === 'string') {
        void queueSave(prevDraft, prevId);
      }
      // 保存已入队，清理旧笔记的草稿/快照条目，避免 Map 无限增长
      draftByNoteRef.current.delete(prevId);
      lastSavedMapRef.current.delete(prevId);
    }

    // 兜底：如果 Map 仍超过上限（例如快速连续切换），驱逐最早条目
    if (draftByNoteRef.current.size > MAX_DRAFT_ENTRIES) {
      const firstKey = draftByNoteRef.current.keys().next().value;
      if (firstKey && firstKey !== noteId) {
        draftByNoteRef.current.delete(firstKey);
        lastSavedMapRef.current.delete(firstKey);
      }
    }

    prevNoteIdRef.current = noteId ?? null;
  }, [noteId, queueSave]);

  // 🔧 修复：追踪上一次初始化的 noteId，避免同一笔记的内容被重复重置
  const lastInitializedNoteIdRef = useRef<string | null>(null);
  
  // 重置内容引用
  // 🔧 重要修复：只在 noteId 真正变化时才重置 draftByNoteRef 和 lastSavedMapRef
  // 之前的实现会在 initialValue 变化时也重置，导致用户编辑被覆盖
  useEffect(() => {
    const isNewNote = noteId !== lastInitializedNoteIdRef.current;

    cancelDebounce();
    contentRef.current = initialValue;
    
    // 🔧 关键修复：只在以下情况重置 draftByNoteRef 和 lastSavedMapRef：
    // 1. noteId 变化（切换到新笔记）
    // 2. 或者该笔记尚未初始化（首次打开）
    if (noteId && isNewNote) {
      // 检查是否已有草稿（用户可能之前编辑过但未保存）
      const existingDraft = draftByNoteRef.current.get(noteId);
      const hasExistingDraft = existingDraft !== undefined && existingDraft !== '';
      
      if (hasExistingDraft) {
        // 只更新 lastSavedMapRef（用于比较），不覆盖用户的草稿
        lastSavedMapRef.current.set(noteId, initialValue || '');
      } else {
        // 新笔记或无草稿，正常初始化
        draftByNoteRef.current.set(noteId, initialValue || '');
        lastSavedMapRef.current.set(noteId, initialValue || '');
      }
      
      lastInitializedNoteIdRef.current = noteId;
    } else if (noteId && !isNewNote) {
      // 同一笔记的 initialValue 变化（可能是内容加载完成）
      // 只在以下情况更新：
      // 1. 当前 draftByNoteRef 为空或未设置（内容尚未加载）
      // 2. 且 initialValue 不为空（真正的内容加载完成）
      const currentDraft = draftByNoteRef.current.get(noteId);
      const isDraftEmpty = currentDraft === undefined || currentDraft === '';
      const isInitialValueValid = initialValue && initialValue.length > 0;
      
      if (isDraftEmpty && isInitialValueValid) {
        draftByNoteRef.current.set(noteId, initialValue);
        lastSavedMapRef.current.set(noteId, initialValue);
      }
    }
    
    if (active?.updated_at) {
      setLastSaved(new Date(active.updated_at));
    } else {
      setLastSaved(null);
    }
    // 🔧 修复：不再在 initialValue 变化时重置 editorApi
    // 之前的实现会导致：initialValue 变化时 setEditorApi(null)，但如果 contentVersionKey 不变
    // （比如 DSTU 模式下 noteId 相同），CrepeEditor 不会重新挂载，onReady 不会被调用，
    // editorApi 保持为 null，工具栏永久禁用
  }, [initialValue, noteId, active?.updated_at]);

  // 🔧 新增：只在 noteId 变化时重置 editorApi（这会触发 CrepeEditor 重新挂载）
  useEffect(() => {
    setEditorApi(null);
  }, [noteId]);

  const handleManualSave = useCallback(async () => {
    if (readOnly) return;
    await flushNoteDraft();
  }, [flushNoteDraft, readOnly]);

  const handleChange = useCallback((markdown: string) => {
    if (readOnly) {
      return;
    }
    contentRef.current = markdown;
    if (noteId) {
      draftByNoteRef.current.set(noteId, markdown);
    }
    cancelDebounce();
    saveTimerRef.current = setTimeout(() => {
      void queueSave(markdown);
    }, AUTO_SAVE_DEBOUNCE_MS);
    
    // IME 合成期间跳过实时事件派发，避免卡顿
    // 合成结束后会由 compositionend 事件触发一次派发
    if (isComposingRef.current) {
      return;
    }
    
    // 清除之前的内容变化定时器
    if (contentChangedTimerRef.current) {
      clearTimeout(contentChangedTimerRef.current);
    }
    
    // 防抖派发内容变化事件（500ms），用于大纲等组件实时更新
    // DSTU 模式下使用 'dstu-note' 作为标识符
    const eventNoteId = isDstuMode ? 'dstu-note' : noteId;
    contentChangedTimerRef.current = setTimeout(() => {
      if (isUnmountedRef.current) return;
      window.dispatchEvent(new CustomEvent('notes:content-changed', {
        detail: { noteId: eventNoteId, content: markdown }
      }));
    }, 500);
  }, [noteId, queueSave, isDstuMode, readOnly]);

  // 保存 ref
  const flushNoteDraftRef = useRef(flushNoteDraft);
  const setEditorRef = useRef(setEditor);
  flushNoteDraftRef.current = flushNoteDraft;
  setEditorRef.current = setEditor;

  // 清理
  useEffect(() => {
    return () => {
      isUnmountedRef.current = true;
      cancelDebounce();
      if (savingTimerRef.current) {
        clearTimeout(savingTimerRef.current);
        savingTimerRef.current = null;
      }
      if (contentChangedTimerRef.current) {
        clearTimeout(contentChangedTimerRef.current);
        contentChangedTimerRef.current = null;
      }
      // 仅 Context 模式下清除编辑器引用
      if (setEditorRef.current) {
        setEditorRef.current(null);
      }
      void flushNoteDraftRef.current();
    };
  }, []);

  // 监听 IME composition 事件，在合成期间跳过实时事件派发
  // 🔧 修复：绑定到编辑器容器而非 window，避免换行后首次输入法卡顿
  useEffect(() => {
    const container = dropZoneRef.current;
    if (!container) return;
    
    const handleCompositionStart = () => {
      isComposingRef.current = true;
    };
    
    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      // 🔧 性能修复：不再在 compositionend 时立即派发事件
      // 之前的做法会绕过 500ms 防抖，导致首字符输入卡顿
      // 现在统一由 handleChange 中的防抖机制处理事件派发
    };
    
    // 使用 capture: true 确保在事件冒泡前捕获，避免与 ProseMirror 内部处理竞争
    container.addEventListener('compositionstart', handleCompositionStart, { capture: true });
    container.addEventListener('compositionend', handleCompositionEnd, { capture: true });
    
    return () => {
      container.removeEventListener('compositionstart', handleCompositionStart, { capture: true });
      container.removeEventListener('compositionend', handleCompositionEnd, { capture: true });
    };
  }, [isDstuMode]);

  // 🔧 修复：监听 canvas:content-changed 事件，用于后端 Canvas 工具更新笔记后刷新编辑器
  useEffect(() => {
    const handleCanvasContentChanged = (event: Event) => {
      const customEvent = event as CustomEvent<{ noteId: string; newContent?: string }>;
      const { noteId: updatedNoteId, newContent } = customEvent.detail;
      
      // 只处理当前激活笔记的更新
      const currentNoteId = noteIdRef.current;
      if (updatedNoteId !== currentNoteId) {
        return;
      }
      
      // 如果有新内容，直接使用；否则从 active 获取
      if (newContent !== undefined && editorApi) {
        // 更新编辑器内容
        editorApi.setMarkdown(newContent);
        // 更新本地引用，避免被误判为未保存
        contentRef.current = newContent;
        if (currentNoteId) {
          draftByNoteRef.current.set(currentNoteId, newContent);
          lastSavedMapRef.current.set(currentNoteId, newContent);
        }
      }
    };
    
    window.addEventListener('canvas:content-changed', handleCanvasContentChanged);
    
    return () => {
      window.removeEventListener('canvas:content-changed', handleCanvasContentChanged);
    };
  }, [editorApi]);

  // beforeunload
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const currentId = noteIdRef.current;
      if (!currentId) return;
      const draft = draftByNoteRef.current.get(currentId) ?? contentRef.current;
      const lastSavedSnapshot = lastSavedMapRef.current.get(currentId) ?? '';
      const hasPendingQueue = pendingSaveQueueRef.current.some((payload) => payload.noteId === currentId);
      const hasPending = draft !== lastSavedSnapshot || hasPendingQueue || inFlightSaveRef.current !== null;
      if (hasPending) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // 键盘快捷键（注册在 document 上，处理后 stopPropagation 防止命令系统重复触发）
  // NOTE: Ctrl+F / ⌘F 不再拦截，让浏览器原生查找工作
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        e.stopPropagation();
        handleManualSave()
          .then(() => showGlobalNotification('success', t('notes:actions.save_success')))
          .catch(() => showGlobalNotification('error', t('notes:actions.save_failed')));
        return;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleManualSave, t]);

  // TODO: Find/Replace handlers — 待 Crepe 支持后重新实现

  // ========== 内容加载状态（支持 DSTU 模式） ==========
  const hasSelection = isDstuMode ? true : !!active;

  // ★ 使用统一的 Tauri 拖拽 Hook（仅提供视觉反馈，文件处理由 CrepeEditor 内部完成）
  const { isDragging: isDraggingOver } = useTauriDragAndDrop({
    dropZoneRef,
    onDropFiles: () => {}, // 不处理文件，由 CrepeEditor 内部处理
    isEnabled: hasSelection && !readOnly,
    feedbackOnly: true, // 仅提供拖拽状态反馈
    feedbackExtensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'heic', 'heif'], // 仅对图片显示反馈
    debugZoneId: 'notes-crepe-editor',
  });
  // DSTU 模式下内容已通过 props 传入，始终认为已加载
  const isContentLoaded = isDstuMode ? true : loadedContentIds.has(noteId ?? '');
  // 使用 noteId + 内容加载状态作为 key
  // - noteId 变化时重新创建编辑器（切换笔记）
  // - 内容加载完成时重新创建编辑器（确保使用正确的初始内容）
  // - updated_at 变化（自动保存）不会导致重建
  // 🔧 修复：DSTU 模式下需要考虑 initialValue 是否已加载
  // - 当 initialValue 为空字符串时，可能是内容未加载完成
  // - 当 initialValue 有内容时，表示内容已加载
  // 使用 initialValue 的长度作为 key 的一部分，确保内容加载后编辑器重新初始化
  const contentVersionKey = isDstuMode 
    ? `dstu:${noteId || 'new'}:${initialValue ? 'loaded' : 'empty'}`
    : (noteId ? `${noteId}:${isContentLoaded ? 'loaded' : 'loading'}` : 'note-empty');

  useEffect(() => {
    if (!hasSelection) {
      setEditorRef.current(null);
    }
  }, [hasSelection]);

  // 编辑器就绪回调
  const handleEditorReady = useCallback((api: CrepeEditorApi) => {
    setEditorApi(api);
    // 将 Crepe API 设置到 Context（仅 Context 模式）
    if (!isDstuMode && setEditor) {
      setEditor(api);
    }
  }, [isDstuMode, setEditor]);

  // AI 编辑保存回调（用于 Canvas AI 编辑后自动保存）
  const handleAISave = useCallback(async (content: string) => {
    if (isDstuMode) {
      if (dstuOnSave) {
        await dstuOnSave(content);
      }
    } else if (noteId && saveNoteContent) {
      await saveNoteContent(noteId, content);
    }
  }, [isDstuMode, dstuOnSave, noteId, saveNoteContent]);

  const { aiEditState, handleAccept, handleReject, isLocked: isAIEditLocked } = useCanvasAIEditHandler({
    noteId,
    editorApi,
    onSave: handleAISave,
    enabled: hasSelection && isContentLoaded,
  });

  const captureViewportMetrics = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return null;
    return {
      scrollTop: Math.round(viewport.scrollTop),
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    };
  }, []);

  // 处理大纲滚动事件
  useEffect(() => {
    const handleScrollToHeading = (e: CustomEvent<{ text: string; normalizedText?: string; level: number }>) => {
      const viewportMetrics = captureViewportMetrics();
      emitOutlineDebugLog({
        category: 'event',
        action: 'scrollToHeading:received',
        details: {
          heading: e.detail,
          noteId: active?.id || null,
          hasEditor: !!editorApi,
          viewportMetrics,
        },
      });
      emitOutlineDebugSnapshot({
        noteId: active?.id || null,
        heading: {
          text: e.detail.text,
          normalized: e.detail.normalizedText,
          level: e.detail.level,
        },
        scrollEvent: {
          reason: 'scrollToHeading:received',
          targetPos: null,
          resolvedPos: null,
          exactMatch: undefined,
        },
        editorState: {
          hasView: !!editorApi,
          hasSelection: false,
          containerScrollTop: viewportMetrics?.scrollTop ?? null,
          containerScrollHeight: viewportMetrics?.scrollHeight ?? null,
          containerClientHeight: viewportMetrics?.clientHeight ?? null,
        },
        domState: {
          viewportExists: !!viewportMetrics,
          viewportSelector: '.notes-editor .scroll-area__viewport',
        },
      });
      if (editorApi?.scrollToHeading) {
        editorApi.scrollToHeading(e.detail.text, e.detail.level, e.detail.normalizedText);
      }
    };

    window.addEventListener('notes:scroll-to-heading' as any, handleScrollToHeading as any);
    return () => {
      window.removeEventListener('notes:scroll-to-heading' as any, handleScrollToHeading as any);
    };
  }, [active?.id, captureViewportMetrics, editorApi]);

  // ★ 拖拽视觉反馈已通过 useTauriDragAndDrop hook 统一处理（见上方）

  // 空状态
  if (!hasSelection) {
    const ShortcutKey = ({ children }: { children: React.ReactNode }) => (
      <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
        {children}
      </kbd>
    );

    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-8 max-w-md w-full p-6 animate-in fade-in zoom-in-95 duration-300">
          <div className="flex flex-col items-center gap-2 text-center">
            <h3 className="text-lg font-medium text-foreground/90">
              {t('notes:editor.empty_state.title')}
            </h3>
            <p className="text-sm text-muted-foreground/70">
              {t('notes:editor.empty_state.description')}
            </p>
          </div>

          <div className="w-full max-w-2xl flex flex-wrap items-stretch justify-center gap-3">
            <NotionButton
              onClick={() => createNote()}
              disabled={readOnly}
              className="w-full min-w-[220px] h-auto py-3 justify-between text-left"
              size="lg"
              variant="default"
            >
              <div className="flex items-center gap-3 text-sm font-medium text-foreground/80">
                <FilePlus className="w-4 h-4 text-muted-foreground transition-colors" />
                {t('notes:sidebar.actions.new_note')}
              </div>
              <div className="flex items-center gap-1">
                <ShortcutKey>{isMacOS() ? '⌘N' : 'Ctrl+N'}</ShortcutKey>
              </div>
            </NotionButton>

            <NotionButton
              onClick={async () => {
                const id = await createFolder();
                if (id) {
                  setSidebarRevealId(id);
                }
              }}
              disabled={readOnly}
              className="w-full min-w-[220px] h-auto py-3 justify-between text-left"
              size="lg"
              variant="default"
            >
              <div className="flex items-center gap-3 text-sm font-medium text-foreground/80">
                <FolderPlus className="w-4 h-4 text-muted-foreground transition-colors" />
                {t('notes:editor.empty_state.actions.new_folder')}
              </div>
            </NotionButton>
            
            <NotionButton
              onClick={() => {
                try { window.dispatchEvent(new CustomEvent('notes:focus-sidebar-search')); } catch {}
              }}
              disabled={readOnly}
              className="w-full min-w-[220px] h-auto py-3 justify-between text-left"
              size="lg"
              variant="default"
            >
              <div className="flex items-center gap-3 text-sm font-medium text-foreground/80">
                <Search className="w-4 h-4 text-muted-foreground transition-colors" />
                {t('notes:editor.empty_state.actions.search_note')}
              </div>
            </NotionButton>
          </div>
        </div>
      </div>
    );
  }

  // DSTU 模式下始终渲染，Context 模式下需要 noteId
  if (!isDstuMode && !noteId) return null;

  return (
    <ErrorBoundary name="NotesEditor">
    <div className={cn("flex-1 min-h-0 flex flex-col bg-background relative", className)}>
      {/* 内容加载中遮罩 - 覆盖在编辑器上方 */}
      {!isContentLoaded && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <span className="loading loading-spinner loading-lg text-muted-foreground/60" />
        </div>
      )}

      {/* TODO: Find & Replace — 待 Crepe 支持后重新实现 (see git history for removed UI) */}

      {/* 图片拖拽覆盖层 */}
      {isDraggingOver && (
        <div 
          className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none animate-in fade-in duration-150"
          style={{ backgroundColor: 'hsl(var(--primary) / 0.08)', backdropFilter: 'blur(2px)' }}
        >
          <div 
            className="flex flex-col items-center gap-4 px-10 py-8 rounded-2xl pointer-events-none"
            style={{ 
              backgroundColor: 'hsl(var(--background) / 0.95)', 
              border: '2.5px dashed hsl(var(--primary))',
              boxShadow: '0 8px 32px hsl(var(--primary) / 0.15), 0 0 0 1px hsl(var(--primary) / 0.1)'
            }}
          >
            <div 
              className="w-16 h-16 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: 'hsl(var(--primary) / 0.12)' }}
            >
              <ImagePlus className="w-8 h-8" style={{ color: 'hsl(var(--primary))' }} />
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <span 
                className="text-lg font-semibold"
                style={{ color: 'hsl(var(--foreground))' }}
              >
                {t('notes:editor.image_upload.drop_overlay_title')}
              </span>
              <span 
                className="text-sm"
                style={{ color: 'hsl(var(--muted-foreground))' }}
              >
                {t('notes:editor.image_upload.drop_overlay_hint')}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* AI 编辑 Diff 面板 */}
      {aiEditState.isActive && (
        <AIDiffPanel
          state={aiEditState}
          onAccept={handleAccept}
          onReject={handleReject}
        />
      )}

      {/* 远程桌面模式：当编辑器被 Portal 到白板时，显示占位符 */}
      {isPortaledToCanvas ? (
        <div className="flex-1 flex items-center justify-center bg-muted/30">
          <div className="flex flex-col items-center gap-4 text-muted-foreground">
            <ExternalLink className="w-12 h-12 opacity-50" />
            <p className="text-sm">{t('notes:editor.portaled_to_canvas')}</p>
            <p className="text-xs opacity-60">{t('notes:editor.portaled_hint')}</p>
          </div>
        </div>
      ) : (
        <>
          {/* 悬浮头部和工具栏 - 不随正文滚动，占满整宽 */}
          <div className="notes-editor-header-section flex-shrink-0 w-full bg-background sticky top-0 z-10">
            {/* 内部内容居中，保持与编辑器一致的最大宽度；移动端减小内边距 */}
            <div className="max-w-[800px] mx-auto px-4 sm:px-8 sm:pl-24">
              <NotesEditorHeader 
                lastSaved={lastSaved} 
                isSaving={isSaving}
                // DSTU 模式 props
                initialTitle={isDstuMode ? initialTitle : undefined}
                onTitleChange={isDstuMode && !readOnly ? dstuOnTitleChange : undefined}
                noteId={noteId}
                readOnly={readOnly}
              />
              <NotesEditorToolbar editor={editorApi} readOnly={readOnly} />
            </div>
          </div>
          
          <CustomScrollArea
            className="notes-editor-content-scroll flex-1"
            viewportClassName="overflow-x-visible"
            viewportRef={scrollViewportRef}
          >
            {/* 编辑器内容区域 */}
            <div
              className="notes-editor-content max-w-[800px] mx-auto min-h-full px-4 sm:px-8 sm:pl-24 relative flex flex-col"
              style={{
                paddingBottom: isSmallScreen
                  ? `calc(30vh + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`
                  : '30vh',
              }}
              ref={dropZoneRef}
            >
              <CrepeEditor
                key={contentVersionKey}
                noteId={noteId}
                className="flex-1 min-h-[500px]"
                defaultValue={initialValue}
                onChange={handleChange}
                onReady={handleEditorReady}
                readonly={readOnly}
              />
            </div>
          </CustomScrollArea>
        </>
      )}
    </div>
    </ErrorBoundary>
  );
};

export default NotesCrepeEditor;
