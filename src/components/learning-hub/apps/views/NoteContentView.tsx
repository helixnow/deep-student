/**
 * NoteContentView - 笔记内容视图
 *
 * 统一应用面板中的笔记编辑视图。
 * 通过 DSTU 协议获取笔记数据，直接传递给编辑器组件。
 * 
 * 改造后移除了对 NotesProvider/NotesContext 的依赖，
 * 所有数据通过 DSTU 节点和 API 获取。
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RotateCcw } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotesCrepeEditor } from '@/components/notes/NotesCrepeEditor';
import { NotesContextPanel } from '@/components/notes/NotesContextPanel';
import { reportError, type VfsError, VfsErrorCode } from '@/shared/result';
import { dstu } from '@/dstu';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { PanelGroup, Panel, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { GripVertical, PanelRight } from 'lucide-react';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { COMMAND_EVENTS, useCommandEvents } from '@/command-palette/hooks/useCommandEvents';
import type { CrepeEditorApi } from '@/components/crepe';

/**
 * 笔记内容视图
 * 
 * 直接使用 DSTU 协议获取和保存笔记数据，
 * 不再依赖 NotesProvider/NotesContext。
 */
const NoteContentView: React.FC<ContentViewProps> = ({
  node,
  onClose,
  onTitleChange,
  readOnly = false,
  isActive = false,
}) => {
  const { t } = useTranslation(['notes', 'common']);
  const isSmallScreen = useMediaQuery("(max-width: 768px)");

  // ========== 右侧面板状态 ==========
  const [rightPanelVisible, setRightPanelVisible] = useState(true);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);

  const toggleRightPanel = useCallback(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    if (rightPanelVisible) {
      panel.collapse();
    } else {
      panel.expand();
    }
  }, [rightPanelVisible]);

  // ========== 状态 ==========
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<VfsError | null>(null);
  
  // 笔记内容状态
  // 🔧 修复：使用 null 表示"未加载"，空字符串表示"已加载但内容为空"
  const [content, setContent] = useState<string | null>(null);
  const [title, setTitle] = useState<string>(node.name || '');
  const [tags, setTags] = useState<string[]>((node.metadata?.tags as string[]) || []);
  const editorApiRef = useRef<CrepeEditorApi | null>(null);
  
  // 🔧 追踪当前加载的笔记 ID，用于防止竞态条件
  const loadingNoteIdRef = React.useRef<string | null>(null);

  const noteId = node.id;

  // ========== 加载笔记内容（提取为可复用函数，支持重试） ==========
  const loadNoteContent = useCallback(async () => {
    // 🔧 修复：记录当前加载的笔记 ID
    const currentNoteId = node.id;
    loadingNoteIdRef.current = currentNoteId;
    
    setIsLoading(true);
    setError(null);
    // ★ 优化体验：不再粗暴地 setContent(null)，保留旧内容（Stale-While-Revalidate），
    // 配合顶部的透明 Loading 指示器，实现无缝切换

    // 通过 DSTU 获取笔记内容
    const result = await dstu.getContent(node.path);

    // 🔧 修复：检查是否仍在加载同一笔记（防止竞态条件）
    if (loadingNoteIdRef.current !== currentNoteId) {
      return;
    }

    if (!result.ok) {
      console.error('[NoteContentView] ❌ 加载笔记内容失败:', result.error);
      if (result.error.code !== VfsErrorCode.NOT_FOUND) {
        reportError(result.error, '加载笔记内容');
      }
      setError(result.error);
      setIsLoading(false);
      return;
    }

    const contentStr = typeof result.value === 'string' ? result.value : '';
    
    setContent(contentStr);
    setTitle(node.name || '');
    // 重新加载时同步最新的 tags（node 可能已更新）
    setTags((node.metadata?.tags as string[]) || []);
    setIsLoading(false);
  }, [node.id, node.path, node.name]);

  useEffect(() => {
    void loadNoteContent();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]); // 只依赖 node.id，避免对象引用变化导致无限循环

  // ========== 保存回调 ==========
  // 内容保存
  const handleSave = useCallback(async (newContent: string) => {
    if (readOnly) return;
    // S-003: 维护模式拦截，防止 Learning Hub 入口绕过写入
    if (useSystemStatusStore.getState().maintenanceMode) {
      showGlobalNotification('warning', t('common:maintenance.blocked_note_save', '维护模式下无法保存笔记'));
      return;
    }
    const result = await dstu.update(node.path, newContent, node.type);
    if (!result.ok) {
      console.error('[NoteContentView] ❌ 保存笔记失败:', result.error);
      reportError(result.error, '保存笔记');
      throw new Error(result.error.toUserMessage());
    }
    setContent(newContent);
  }, [node.path, node.type, readOnly, t]);

  // 标题变更
  const handleTitleChange = useCallback(async (newTitle: string) => {
    if (readOnly) return;
    // S-003: 维护模式拦截
    if (useSystemStatusStore.getState().maintenanceMode) {
      showGlobalNotification('warning', t('common:maintenance.blocked_note_save', '维护模式下无法保存笔记'));
      return;
    }
    const result = await dstu.setMetadata(node.path, { title: newTitle });
    if (!result.ok) {
      console.error('[NoteContentView] Failed to update title:', result.error);
      reportError(result.error, '更新标题');
      throw new Error(result.error.toUserMessage());
    }
    setTitle(newTitle);
    // 通知父级面板标题已更新
    onTitleChange?.(newTitle);
  }, [node.path, readOnly, onTitleChange, t]);

  // 标签变更
  const handleTagsChange = useCallback(async (newTags: string[]) => {
    if (readOnly) return;
    const result = await dstu.setMetadata(node.path, { tags: newTags });
    if (!result.ok) {
      console.error('[NoteContentView] Failed to update tags:', result.error);
      reportError(result.error, '更新标签');
      throw new Error(result.error.toUserMessage());
    }
    setTags(newTags);
  }, [node.path, readOnly]);

  useCommandEvents(
    {
      [COMMAND_EVENTS.NOTES_FORCE_SAVE]: () => {
        if (!isActive || readOnly) return;
        const editor = editorApiRef.current;
        if (!editor || editor.isReadonly()) return;
        void handleSave(editor.getMarkdown())
          .then(() => {
            showGlobalNotification('success', t('notes:actions.save_success', '保存成功'));
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : t('notes:actions.save_failed', '保存失败');
            showGlobalNotification('error', msg);
          });
      },
      [COMMAND_EVENTS.NOTES_TOGGLE_OUTLINE]: () => {
        if (!isActive || isSmallScreen) return;
        toggleRightPanel();
      },
      [COMMAND_EVENTS.NOTES_INSERT_MATH]: () => {
        if (!isActive || readOnly || editorApiRef.current?.isReadonly()) return;
        editorApiRef.current?.insertAtCursor('\n$$\n\n$$\n');
      },
      [COMMAND_EVENTS.NOTES_INSERT_TABLE]: () => {
        if (!isActive || readOnly || editorApiRef.current?.isReadonly()) return;
        editorApiRef.current?.insertTable();
      },
      [COMMAND_EVENTS.NOTES_INSERT_CODEBLOCK]: () => {
        if (!isActive || readOnly || editorApiRef.current?.isReadonly()) return;
        editorApiRef.current?.insertCodeBlock();
      },
      [COMMAND_EVENTS.NOTES_INSERT_LINK]: () => {
        if (!isActive || readOnly || editorApiRef.current?.isReadonly()) return;
        editorApiRef.current?.insertLink('https://', '');
      },
      [COMMAND_EVENTS.NOTES_INSERT_IMAGE]: () => {
        if (!isActive || readOnly || editorApiRef.current?.isReadonly()) return;
        editorApiRef.current?.insertImage('https://', '');
      },
      [COMMAND_EVENTS.AI_CONTINUE_WRITING]: () => {
        if (!isActive || readOnly || editorApiRef.current?.isReadonly()) return;
        showGlobalNotification('info', t('notes:ai.continue_not_available', 'AI 续写命令暂不可用，请使用聊天面板发起编辑。'));
      },
    },
    true
  );

  // ========== 渲染 ==========
  // 🔧 优化：Stale-While-Revalidate
  // 当有旧内容 (content !== null) 但正在加载新内容 (isLoading) 时，不要白屏，而是保留旧内容+顶部透明进度条
  
  if (isLoading && content === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">
          {t('common:loading', '加载中...')}
        </span>
      </div>
    );
  }

  if (error) {
    const message = error.code === VfsErrorCode.NOT_FOUND
      ? t('notes:error.notFound', '笔记不存在或已被删除')
      : error.toUserMessage();
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <AlertCircle className="w-8 h-8 text-destructive mb-2" />
        <span className="text-destructive">{message}</span>
        <div className="flex gap-2 mt-3">
          <NotionButton variant="primary" onClick={() => loadNoteContent()}>
            {t('common:retry', '重试')}
          </NotionButton>
          {onClose && (
            <NotionButton variant="ghost" onClick={onClose}>
              {t('common:close', '关闭')}
            </NotionButton>
          )}
        </div>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      {isLoading && content !== null && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-primary/20 z-50 overflow-hidden">
          <div className="h-full bg-primary animate-[indeterminate_1.5s_infinite_linear]" />
        </div>
      )}
      {/* 右侧栏开关按钮 - 置于 PanelGroup 之上，避免被编辑器 sticky header 遮挡 */}
      {!isSmallScreen && (
        <div className="flex items-center justify-end px-2 py-0.5 flex-shrink-0">
          <CommonTooltip
            content={rightPanelVisible ? t('notes:context.collapse_panel', '收起侧边栏') : t('notes:context.expand_panel', '展开侧边栏')}
            position="bottom"
          >
            <NotionButton
              variant="ghost"
              iconOnly
              size="sm"
              className={cn(
                "h-6 w-6 text-muted-foreground/50 hover:text-foreground hover:bg-accent transition-colors",
                !rightPanelVisible && "text-muted-foreground/70"
              )}
              onClick={toggleRightPanel}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </NotionButton>
          </CommonTooltip>
        </div>
      )}
      <PanelGroup direction="horizontal" autoSaveId="learning-hub-note-layout" className="flex-1 min-h-0">
        <Panel
          defaultSize={80}
          minSize={50}
          id="learning-hub-note-editor"
          order={1}
          className="flex flex-col min-h-0"
        >
          <NotesCrepeEditor
            initialContent={content}
            initialTitle={title}
            onSave={readOnly ? undefined : handleSave}
            onTitleChange={readOnly ? undefined : handleTitleChange}
            noteId={noteId}
            className="flex-1 min-h-0"
            readOnly={readOnly}
            onEditorReady={(api) => {
              editorApiRef.current = api;
            }}
          />
        </Panel>

        {!isSmallScreen && (
          <>
            <PanelResizeHandle className={cn(
              "w-1 bg-border/40 hover:bg-primary/20 transition-colors flex items-center justify-center group",
              !rightPanelVisible && "pointer-events-none opacity-0 !w-0"
            )}>
              <GripVertical className="w-3 h-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
            </PanelResizeHandle>
            <Panel
              ref={rightPanelRef}
              defaultSize={20}
              minSize={15}
              maxSize={30}
              collapsedSize={0}
              id="learning-hub-note-outline"
              order={2}
              collapsible
              onCollapse={() => setRightPanelVisible(false)}
              onExpand={() => setRightPanelVisible(true)}
              className={cn(
                "flex flex-col min-h-0 bg-muted/5 transition-all",
                rightPanelVisible ? "border-l border-border/40" : "border-l-0"
              )}
            >
              {rightPanelVisible && (
                <NotesContextPanel
                  noteId={noteId}
                  title={title}
                  createdAt={node.createdAt}
                  updatedAt={node.updatedAt}
                  tags={tags}
                  content={content || ''}
                  onTagsChange={readOnly ? undefined : handleTagsChange}
                />
              )}
            </Panel>
          </>
        )}
      </PanelGroup>

    </div>
  );
};

export default NoteContentView;
