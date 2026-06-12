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
import { CircleNotch, WarningCircle, ArrowCounterClockwise } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotesCrepeEditor } from '@/features/notes/NotesCrepeEditor';
import { NotesContextPanel } from '@/features/notes/NotesContextPanel';
import { reportError, type VfsError, VfsErrorCode } from '@/shared/result';
import { dstu } from '@/dstu';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { PanelGroup, Panel, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { DotsSixVertical, SidebarSimple } from '@phosphor-icons/react';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { Sheet, SheetContent } from '@/components/ui/shad/Sheet';
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
  // N-1: 与 App shell 的 <768 断点对齐（useIsMobile 为 min-width:768 的精确取反）
  const isSmallScreen = useIsMobile();

  // ========== 右侧面板状态 ==========
  const [rightPanelVisible, setRightPanelVisible] = useState(true);
  // 移动端：上下文面板（大纲/标签）以 Sheet 形式呈现
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
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
  // ★ R1 修复：记录 content 归属的笔记 ID。
  // SWR 切换笔记时旧内容会短暂保留，若直接传给编辑器会把旧笔记内容
  // 初始化进新笔记的草稿（数据污染）。归属不匹配时编辑器渲染 loading。
  const [contentNoteId, setContentNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState<string>(node.name || '');
  const [tags, setTags] = useState<string[]>((node.metadata?.tags as string[]) || []);
  const editorApiRef = useRef<CrepeEditorApi | null>(null);
  
  // 🔧 追踪当前加载的笔记 ID，用于防止竞态条件
  const loadingNoteIdRef = React.useRef<string | null>(null);

  // ★ R3 修复：乐观锁基线。记录当前已知的笔记 updated_at（毫秒），
  // 保存时传给后端做冲突检测；watch 事件中用于区分自身保存与外部更新。
  const lastKnownUpdatedAtRef = useRef<number | null>(null);
  // ★ F8：基线的 state 镜像，供侧栏"更新时间"实时显示
  const [lastKnownUpdatedAt, setLastKnownUpdatedAt] = useState<number | null>(null);
  const updateKnownBaseline = useCallback((ms: number | null) => {
    lastKnownUpdatedAtRef.current = ms;
    setLastKnownUpdatedAt(ms);
  }, []);
  // ★ R3：当前已落盘的内容快照（用于冲突时判断外部是否真的改了内容）
  const persistedContentRef = useRef<string | null>(null);
  // ★ F9：内容保存进行中标志。自身保存触发的 watch 事件无需整页刷新
  const isSavingContentRef = useRef(false);

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

    // ★ R3：并行获取最新节点（新鲜的 updatedAt/title/tags）与内容
    const [nodeResult, result] = await Promise.all([
      dstu.get(node.path),
      dstu.getContent(node.path),
    ]);

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
    const freshNode = nodeResult.ok ? nodeResult.value : null;

    setContent(contentStr);
    setContentNoteId(currentNoteId);
    persistedContentRef.current = contentStr;
    updateKnownBaseline(freshNode?.updatedAt ?? node.updatedAt ?? null);
    setTitle(freshNode?.name ?? node.name ?? '');
    // 重新加载时同步最新的 tags（node 可能已更新）
    setTags(((freshNode?.metadata?.tags ?? node.metadata?.tags) as string[]) || []);
    setIsLoading(false);
  }, [node.id, node.path, node.name, updateKnownBaseline]);

  useEffect(() => {
    void loadNoteContent();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]); // 只依赖 node.id，避免对象引用变化导致无限循环

  // ========== 外部更新刷新（R3） ==========
  // 从磁盘重新拉取最新内容并通知编辑器原位刷新（不重挂载）。
  // forceApply=true：强制覆盖编辑器（冲突解决，外部版本胜出）；
  // forceApply=false：仅在编辑器无未保存修改时应用（watch 静默同步）。
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  const refreshFromDisk = useCallback(async (forceApply: boolean) => {
    const currentNoteId = node.id;
    const [nodeResult, contentResult] = await Promise.all([
      dstu.get(node.path),
      dstu.getContent(node.path),
    ]);
    // 防竞态：期间切换了笔记则放弃
    if (loadingNoteIdRef.current !== null && loadingNoteIdRef.current !== currentNoteId) {
      return;
    }
    if (nodeResult.ok && nodeResult.value) {
      updateKnownBaseline(nodeResult.value.updatedAt ?? lastKnownUpdatedAtRef.current);
      setTitle(nodeResult.value.name || '');
      setTags((nodeResult.value.metadata?.tags as string[]) || []);
      onTitleChangeRef.current?.(nodeResult.value.name || '');
    }
    if (!contentResult.ok) {
      return;
    }
    const latest = typeof contentResult.value === 'string' ? contentResult.value : '';
    setContent(latest);
    setContentNoteId(currentNoteId);
    persistedContentRef.current = latest;
    // 通知编辑器原位刷新（由 NotesCrepeEditor 监听，带脏检查）
    window.dispatchEvent(new CustomEvent('notes:external-updated', {
      detail: { noteId: currentNoteId, content: latest, force: forceApply },
    }));
  }, [node.id, node.path, updateKnownBaseline]);

  const refreshFromDiskRef = useRef(refreshFromDisk);
  refreshFromDiskRef.current = refreshFromDisk;

  // ★ R3：监听 DSTU watch 事件，外部更新（其他面板/AI 工具/同步）时自动刷新
  useEffect(() => {
    const currentNoteId = node.id;
    const unwatch = dstu.watch('*', (event) => {
      if (event.type !== 'updated' || !event.node) return;
      if (event.node.id !== currentNoteId) return;
      const known = lastKnownUpdatedAtRef.current ?? 0;
      const incoming = event.node.updatedAt ?? 0;
      // 等于/早于已知基线的事件来自自身保存或重复派发，忽略
      if (incoming <= known) return;
      updateKnownBaseline(incoming);
      // ★ F9：自身保存进行中时跳过刷新。
      // 事件若来自自身保存（emit 先于 invoke 返回），applySuccess 会完成基线同步；
      // 若来自真正的外部更新，进行中的保存会被乐观锁拒绝并走冲突刷新流程。
      if (isSavingContentRef.current) return;
      void refreshFromDiskRef.current(false);
    });
    return unwatch;
  }, [node.id, updateKnownBaseline]);

  // ========== 保存回调 ==========
  // 内容保存
  const handleSave = useCallback(async (newContent: string) => {
    if (readOnly) return;
    // S-003: 维护模式拦截，防止 Learning Hub 入口绕过写入
    if (useSystemStatusStore.getState().maintenanceMode) {
      showGlobalNotification('warning', t('common:maintenance.blocked_note_save', '维护模式下无法保存笔记'));
      return;
    }
    // ★ R3：携带乐观锁基线，防止静默覆盖其他位置的更新
    const applySuccess = (updatedAt?: number) => {
      setContent(newContent);
      setContentNoteId(node.id);
      persistedContentRef.current = newContent;
      updateKnownBaseline(updatedAt ?? lastKnownUpdatedAtRef.current);
    };

    isSavingContentRef.current = true;
    try {
      const result = await dstu.update(node.path, newContent, node.type, {
        expectedUpdatedAtMs: lastKnownUpdatedAtRef.current ?? undefined,
      });
      if (result.ok) {
        applySuccess(result.value.updatedAt);
        return;
      }

      if (result.error.code === VfsErrorCode.CONFLICT) {
        // 冲突：先判断磁盘内容是否真的变化。
        // 标题/标签更新（setMetadata）也会推进 updated_at，但内容基线未变，
        // 此时以新基线重试即可，不应丢弃用户输入。
        const [latestNode, latestContent] = await Promise.all([
          dstu.get(node.path),
          dstu.getContent(node.path),
        ]);
        const latestStr = latestContent.ok && typeof latestContent.value === 'string'
          ? latestContent.value
          : null;

        if (
          latestNode.ok && latestNode.value &&
          latestStr !== null &&
          latestStr === persistedContentRef.current
        ) {
          updateKnownBaseline(latestNode.value.updatedAt ?? lastKnownUpdatedAtRef.current);
          setTitle(latestNode.value.name || '');
          setTags((latestNode.value.metadata?.tags as string[]) || []);
          const retry = await dstu.update(node.path, newContent, node.type, {
            expectedUpdatedAtMs: lastKnownUpdatedAtRef.current ?? undefined,
          });
          if (retry.ok) {
            applySuccess(retry.value.updatedAt);
            return;
          }
        }

        // 真实内容冲突：外部已写入更新版本。以外部版本为准刷新编辑器，
        // 但用户版本不丢弃——通知中提供"恢复我的版本"动作。
        console.warn('[NoteContentView] ⚠️ 保存冲突，刷新为最新版本:', result.error);
        const conflictNoteId = node.id;
        const userVersion = newContent;
        showGlobalNotification(
          'warning',
          t('notes:editor.conflict_refreshed', '笔记已在其他位置被修改，已刷新为最新版本'),
          undefined,
          {
            action: {
              label: t('notes:editor.conflict_restore_mine', '恢复我的版本'),
              onClick: () => {
                // 把用户版本写回编辑器（force 路径会同步草稿基线），
                // 并显式入队保存：以已刷新的乐观锁基线覆盖外部版本。
                window.dispatchEvent(new CustomEvent('notes:external-updated', {
                  detail: { noteId: conflictNoteId, content: userVersion, force: true },
                }));
                window.dispatchEvent(new CustomEvent('notes:request-save', {
                  detail: { noteId: conflictNoteId, content: userVersion },
                }));
              },
            },
          }
        );
        await refreshFromDisk(true);
        const conflictError = new Error(result.error.toUserMessage());
        (conflictError as Error & { isNoteConflict?: boolean }).isNoteConflict = true;
        throw conflictError;
      }

      console.error('[NoteContentView] ❌ 保存笔记失败:', result.error);
      reportError(result.error, '保存笔记');
      throw new Error(result.error.toUserMessage());
    } finally {
      isSavingContentRef.current = false;
    }
  }, [node.id, node.path, node.type, readOnly, t, refreshFromDisk, updateKnownBaseline]);

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
        if (!isActive) return;
        if (isSmallScreen) {
          setMobilePanelOpen(prev => !prev);
        } else {
          toggleRightPanel();
        }
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
  
  // ★ R1 修复：内容必须归属当前笔记才能传给编辑器。
  // 切换笔记的过渡期（content 还是旧笔记的）渲染 loading，
  // 防止旧笔记内容被初始化进新笔记的草稿并被自动保存。
  const isContentReady = content !== null && contentNoteId === node.id;

  if (isLoading && content === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <CircleNotch size={24} className="animate-spin text-muted-foreground" />
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
        <WarningCircle size={32} className="text-destructive mb-2" />
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
      {/* 右侧栏开关按钮 - 置于 PanelGroup 之上，避免被编辑器 sticky header 遮挡
          移动端改为打开底部 Sheet（大纲/标签在小屏可达） */}
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
              "h-6 w-6 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors",
              !rightPanelVisible && "text-muted-foreground/70"
            )}
            onClick={isSmallScreen ? () => setMobilePanelOpen(true) : toggleRightPanel}
          >
            <SidebarSimple size={14} />
          </NotionButton>
        </CommonTooltip>
      </div>
      <PanelGroup direction="horizontal" autoSaveId="learning-hub-note-layout" className="flex-1 min-h-0">
        <Panel
          defaultSize={80}
          minSize={50}
          id="learning-hub-note-editor"
          order={1}
          className="flex flex-col min-h-0"
        >
          {isContentReady ? (
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
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <CircleNotch size={20} className="animate-spin text-muted-foreground/60" />
            </div>
          )}
        </Panel>

        {!isSmallScreen && (
          <>
            <PanelResizeHandle className={cn(
              "w-1 bg-border/40 hover:bg-primary/20 transition-colors flex items-center justify-center group",
              !rightPanelVisible && "pointer-events-none opacity-0 !w-0"
            )}>
              <DotsSixVertical size={12} className="text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors" />
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
                  updatedAt={lastKnownUpdatedAt ?? node.updatedAt}
                  tags={tags}
                  content={isContentReady ? (content || '') : ''}
                  onTagsChange={readOnly ? undefined : handleTagsChange}
                />
              )}
            </Panel>
          </>
        )}
      </PanelGroup>

      {/* 移动端：上下文面板 Sheet（大纲/标签/元信息） */}
      {isSmallScreen && (
        <Sheet open={mobilePanelOpen} onOpenChange={setMobilePanelOpen}>
          <SheetContent side="right" className="w-[min(85vw,20rem)] p-0 flex flex-col">
            <NotesContextPanel
              noteId={noteId}
              title={title}
              createdAt={node.createdAt}
              updatedAt={lastKnownUpdatedAt ?? node.updatedAt}
              tags={tags}
              content={isContentReady ? (content || '') : ''}
              onTagsChange={readOnly ? undefined : handleTagsChange}
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
};

export default NoteContentView;
