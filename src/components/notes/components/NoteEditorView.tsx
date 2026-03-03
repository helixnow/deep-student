/**
 * NoteEditorView - 笔记编辑器核心视图组件
 * 
 * 可被 NotesCrepeEditor（笔记模块）和 NoteEmbedNode（白板节点）共同使用
 * 通过 useNotes() 获取数据，确保状态共享
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { CrepeEditor, type CrepeEditorApi } from '../../crepe';
import { NotesEditorToolbar } from './NotesEditorToolbar';
import { useNotesOptional } from '../NotesContext';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '../../custom-scroll-area';

const AUTO_SAVE_DEBOUNCE_MS = 1500;

interface NoteEditorViewProps {
  // ========== DSTU 模式 props（优先级更高） ==========
  /** 初始内容（DSTU 模式：直接传入内容） */
  initialContent?: string;
  /** 初始标题（DSTU 模式） */
  initialTitle?: string;
  /** 保存回调（DSTU 模式：内容保存时调用） */
  onSave?: (content: string) => Promise<void>;
  /** 标题变更回调（DSTU 模式） */
  onTitleChange?: (title: string) => Promise<void>;
  
  // ========== Context 模式 props（向后兼容） ==========
  /** 笔记 ID（Context 模式：通过 useNotes() 获取数据） */
  noteId?: string;
  
  // ========== 通用 props ==========
  /** 紧凑模式（用于白板嵌入） */
  compact?: boolean;
  /** 是否显示工具栏 */
  showToolbar?: boolean;
  /** 编辑器就绪回调 */
  onEditorReady?: (api: CrepeEditorApi) => void;
  /** 自定义类名 */
  className?: string;
}

export const NoteEditorView: React.FC<NoteEditorViewProps> = ({
  // DSTU 模式 props
  initialContent,
  initialTitle,
  onSave,
  onTitleChange,
  // Context 模式 props
  noteId,
  // 通用 props
  compact = false,
  showToolbar = true,
  onEditorReady,
  className,
}) => {
  const { t } = useTranslation(['notes', 'common']);
  
  // 检测是否为 DSTU 模式（通过是否传入 initialContent 判断）
  const isDstuMode = initialContent !== undefined;
  
  // ========== Context 获取（可选） ==========
  // 使用 useNotesOptional 而非 useNotes，在没有 Provider 时返回 null
  // 这样 DSTU 模式下无需 NotesProvider 包装
  const notesContext = useNotesOptional();
  
  // 从 Context 解构需要的方法（仅在 Context 模式下使用）
  const notes = notesContext?.notes ?? [];
  const loadedContentIds = notesContext?.loadedContentIds ?? new Set<string>();
  const saveNoteContent = notesContext?.saveNoteContent;
  const ensureNoteContent = notesContext?.ensureNoteContent;
  const setEditor = notesContext?.setEditor;
  const renameItem = notesContext?.renameItem;

  const [editorApi, setEditorApi] = useState<CrepeEditorApi | null>(null);
  const containerRef = useRef<HTMLDivElement>(null); // 编辑器容器引用，用于绑定 composition 事件
  
  // 标题编辑状态
  const [titleInput, setTitleInput] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const pendingTitleRef = useRef<string | null>(null);
  
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const contentRef = useRef<string>();
  const isUnmountedRef = useRef(false);
  const isComposingRef = useRef(false); // IME 合成状态追踪
  const contentChangedTimerRef = useRef<ReturnType<typeof setTimeout>>(); // 内容变化事件防抖
  
  // DSTU 模式保存状态
  const [isSaving, setIsSaving] = useState(false);

  // ========== 数据来源判断 ==========
  // DSTU 模式：使用传入的 props
  // Context 模式：从 notes 数组中获取当前笔记
  const note = isDstuMode ? null : notes.find(n => n.id === noteId);
  const isContentLoaded = isDstuMode ? true : (noteId ? loadedContentIds.has(noteId) : false);
  const initialValue = isDstuMode ? (initialContent || '') : (note?.content_md || '');
  const displayTitle = isDstuMode ? (initialTitle || '') : (note?.title || '');

  // 同步标题状态
  useEffect(() => {
    if (!isEditingTitle) {
      if (pendingTitleRef.current !== null) {
        if (displayTitle === pendingTitleRef.current) {
          pendingTitleRef.current = null;
          setTitleInput(displayTitle);
        } else {
          setTitleInput(pendingTitleRef.current);
        }
      } else {
        setTitleInput(displayTitle);
      }
    }
  }, [displayTitle, isEditingTitle]);

  // 标题提交处理
  const handleTitleSubmit = useCallback(async () => {
    setIsEditingTitle(false);
    if (titleInput.trim() === displayTitle.trim()) {
      pendingTitleRef.current = null;
      return;
    }
    pendingTitleRef.current = titleInput;
    
    if (isDstuMode) {
      // DSTU 模式：调用 onTitleChange 回调
      if (onTitleChange) {
        try {
          await onTitleChange(titleInput);
        } catch (err: unknown) {
          console.error('[NoteEditorView] DSTU title change failed:', err);
        }
      }
    } else {
      // Context 模式：调用 renameItem
      if (noteId && renameItem) {
        renameItem(noteId, titleInput);
      }
    }
  }, [isDstuMode, noteId, titleInput, displayTitle, renameItem, onTitleChange]);

  // 确保内容已加载（仅 Context 模式）
  useEffect(() => {
    if (!isDstuMode && noteId && !isContentLoaded && ensureNoteContent) {
      void ensureNoteContent(noteId);
    }
  }, [isDstuMode, noteId, isContentLoaded, ensureNoteContent]);

  // 清理定时器和标记卸载状态
  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      const pendingContent = contentRef.current;
      const shouldFlush = !!pendingContent && pendingContent !== noteContent;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = undefined;
      }
      // 卸载前尽力同步最后一次编辑，避免防抖窗口内的内容丢失
      if (shouldFlush) {
        if (isDstuMode) {
          if (onSave) {
            void onSave(pendingContent).catch((err: unknown) => {
              console.error('[NoteEditorView] DSTU flush save failed on unmount:', err);
            });
          }
        } else if (noteId && saveNoteContent) {
          void saveNoteContent(noteId, pendingContent);
        }
      }
      if (contentChangedTimerRef.current) {
        clearTimeout(contentChangedTimerRef.current);
        contentChangedTimerRef.current = undefined;
      }
    };
  }, [isDstuMode, noteId, noteContent, onSave, saveNoteContent]);

  // 监听 IME composition 事件，在合成期间跳过实时事件派发
  // 🔧 修复：绑定到编辑器容器而非 window，避免换行后首次输入法卡顿
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    const handleCompositionStart = () => {
      isComposingRef.current = true;
    };
    
    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      // 🔧 性能修复：不再在 compositionend 时立即派发事件
      // 之前的做法会绕过 500ms 防抖，导致首字符输入卡顿
      // 现在统一由 handleContentChange 中的防抖机制处理事件派发
    };
    
    // 使用 capture: true 确保在事件冒泡前捕获，避免与 ProseMirror 内部处理竞争
    container.addEventListener('compositionstart', handleCompositionStart, { capture: true });
    container.addEventListener('compositionend', handleCompositionEnd, { capture: true });
    
    return () => {
      container.removeEventListener('compositionstart', handleCompositionStart, { capture: true });
      container.removeEventListener('compositionend', handleCompositionEnd, { capture: true });
    };
  }, [noteId]);

  // 内容变化处理（防抖保存）
  const handleContentChange = useCallback((newContent: string) => {
    // 如果组件已卸载，不创建新定时器
    if (isUnmountedRef.current) return;
    
    contentRef.current = newContent;
    
    // 清除之前的保存定时器
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    
    // 防抖保存
    saveTimerRef.current = setTimeout(async () => {
      // 双重检查：定时器回调时再次确认组件未卸载
      if (isUnmountedRef.current) return;
      
      if (isDstuMode) {
        // DSTU 模式：调用 onSave 回调
        if (onSave) {
          setIsSaving(true);
          try {
            await onSave(newContent);
          } catch (err: unknown) {
            console.error('[NoteEditorView] DSTU save failed:', err);
          } finally {
            if (!isUnmountedRef.current) {
              setIsSaving(false);
            }
          }
        }
      } else {
        // Context 模式：通过 NotesContext.saveNoteContent 处理
        if (noteId && saveNoteContent) {
          void saveNoteContent(noteId, newContent);
        }
      }
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
    // DSTU 模式下使用 noteId 参数作为标识符
    const eventNoteId = isDstuMode ? 'dstu-note' : noteId;
    contentChangedTimerRef.current = setTimeout(() => {
      if (isUnmountedRef.current) return;
      window.dispatchEvent(new CustomEvent('notes:content-changed', {
        detail: { noteId: eventNoteId, content: newContent }
      }));
    }, 500);
  }, [isDstuMode, noteId, saveNoteContent, onSave]);

  // 编辑器就绪回调
  const handleEditorReady = useCallback((api: CrepeEditorApi) => {
    setEditorApi(api);
    // 如果不是紧凑模式且非 DSTU 模式，将编辑器设置到 Context（用于主笔记模块的全局功能）
    if (!compact && !isDstuMode && setEditor) {
      setEditor(api);
    }
    onEditorReady?.(api);
  }, [compact, isDstuMode, setEditor, onEditorReady]);

  // 内容版本 key（用于强制重建编辑器）
  const contentVersionKey = isDstuMode 
    ? `dstu:${initialContent?.slice(0, 20) || 'empty'}` 
    : `${noteId}:${isContentLoaded ? 'loaded' : 'loading'}`;

  // 加载状态
  if (!isContentLoaded) {
    return (
      <div className={cn("flex items-center justify-center h-full py-8", className)}>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cn("flex flex-col h-full", className)}>
      {/* 标题区域 - pl-20 与编辑器对齐，给左侧 block handle 留足空间 */}
      <div className={cn(
        "flex-shrink-0 pl-20 pr-4",
        compact ? "pt-2 pb-1" : "pt-4 pb-2"
      )}>
        <input
          className={cn(
            "w-full bg-transparent border-none outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0",
            compact 
              ? "text-lg font-semibold text-foreground/90" 
              : "text-2xl font-bold text-foreground/90"
          )}
          value={titleInput}
          onChange={(e) => {
            setTitleInput(e.target.value);
            setIsEditingTitle(true);
          }}
          onBlur={handleTitleSubmit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
            e.stopPropagation();
          }}
          placeholder={t('notes:common.untitled')}
        />
      </div>
      
      {/* 工具栏 - pl-[4.5rem] 与标题/编辑器对齐 */}
      {showToolbar && (
        <div className={cn(
          "flex-shrink-0 border-b border-border pl-[4.5rem]",
          compact && "note-embed-toolbar"
        )}>
          <NotesEditorToolbar editor={editorApi} compact={compact} />
        </div>
      )}
      
      {/* 编辑器 */}
      <CustomScrollArea 
        className="flex-1 min-h-0"
        viewportClassName="overflow-x-visible"
      >
        {/* pl-20 给左侧 block handle (加号和拖拽手柄) 留出足够空间, pr-6 右边距确保内容与边缘有间距 */}
        <div className={cn("pl-20 pr-6", compact ? "pb-4" : "pb-8")}>
          <CrepeEditor
            key={contentVersionKey}
            className={cn("min-h-[200px]")}
            noteId={noteId}
            defaultValue={initialValue}
            onChange={handleContentChange}
            onReady={handleEditorReady}
          />
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default NoteEditorView;
