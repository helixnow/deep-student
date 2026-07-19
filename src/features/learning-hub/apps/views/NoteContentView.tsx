/**
 * NoteContentView - 笔记内容视图
 *
 * 统一应用面板中的笔记编辑视图。
 * 通过 DSTU 协议获取笔记数据，直接传递给编辑器组件。
 * 
 * 改造后移除了对 NotesProvider/NotesContext 的依赖，
 * 所有数据通过 DSTU 节点和 API 获取。
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretLeft, SidebarSimple, WarningCircle, X } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotesCrepeEditor } from '@/features/notes/NotesCrepeEditor';
import { NotesContextPanel } from '@/features/notes/NotesContextPanel';
import { reportError, toVfsError, VfsError, VfsErrorCode } from '@/shared/result';
import { dstu } from '@/dstu';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { COMMAND_EVENTS, useCommandEvents } from '@/command-palette/hooks/useCommandEvents';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import type { CrepeEditorApi } from '@/components/crepe';
import {
  DEFAULT_INITIAL_LINE_WINDOW,
  composeWindowedSave,
  createMarkdownWindow,
  expandMarkdownWindow,
  getLoadMoreLineChunk,
  shouldWindowMarkdown,
  type MarkdownLoadMoreResult,
  type MarkdownWindow,
} from '@/features/notes/markdownWindow';
import { loadInitialLineWindowSetting } from '@/features/notes/markdownWindowSettings';
import {
  registerNoteEditor,
  unregisterNoteEditor,
} from '@/features/workbench/agent/drivers/noteDriver';
import { isContentDirty } from '@/features/workbench/apps/content/contentDirtyRegistry';
import { normalizeResourceInstanceKey } from '@/features/workbench/apps/content/resourceIdentity';
// 顶部 SWR 刷新条依赖 progress-indeterminate 关键帧（设计系统 Progress 样式），
// 显式引入确保本视图独立加载时关键帧可用
import '@/components/ui/shad/Progress.css';

function getMarkdownLineCount(markdown: string): number {
  return markdown.split('\n').length;
}

function projectMarkdownWindow(markdown: string, requestedLines: number): MarkdownWindow {
  const projected = createMarkdownWindow(markdown, requestedLines);
  if (!shouldWindowMarkdown(projected.totalLineCount, requestedLines)) {
    return {
      loadedMarkdown: markdown,
      loadedLineCount: projected.totalLineCount,
      totalLineCount: projected.totalLineCount,
      hasMore: false,
    };
  }
  return projected;
}

/**
 * Read the OCC token before reading content. The two calls are not an atomic
 * database snapshot, but this order preserves the safety invariant: a write
 * racing the reads can only leave us with an older token, so the next save is
 * rejected. Starting both calls together could pair a newer token with older
 * content and let a later save silently overwrite that newer content.
 */
async function readOccSafeNoteSnapshot(path: string) {
  const nodeResult = await dstu.get(path);
  const contentResult = await dstu.getContent(path);
  return { nodeResult, contentResult };
}

/**
 * 笔记编辑器骨架屏。
 * 模拟真实编辑器的标题 + 工具栏 + 正文行结构，并与 NotesCrepeEditor 的
 * 与编辑器可读内容列完全对齐，加载完成时内容原位淡入、无布局跳动
 * （此前的居中 spinner 会在编辑器挂载时产生整屏布局突变）。
 */
const NoteEditorSkeleton: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex-1 min-h-0 overflow-hidden" role="status" aria-label={label}>
    <div className="flex h-9 items-center border-b border-border px-5 sm:px-12">
      <Skeleton className="h-7 w-7" />
      <div className="ml-auto flex gap-1">
        <Skeleton className="h-7 w-7" />
        <Skeleton className="h-7 w-7" />
        <Skeleton className="h-7 w-7" />
      </div>
    </div>
    <div className="w-full max-w-[var(--notes-content-max-w,816px)] mx-auto px-5 sm:px-12 pt-7 flex flex-col">
      {/* 标题行 */}
      <Skeleton className="h-9 w-1/2" />
      {/* 正文行 */}
      <div className="mt-10 flex flex-col gap-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-9/12" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  </div>
);

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
  focusOnActive = false,
  onSaveStateChange,
  hostWindowId,
  propertiesPanelDisabled = false,
}) => {
  const { t } = useTranslation(['notes', 'common']);
  const focusOnActiveRef = useRef(focusOnActive);
  const isActiveRef = useRef(isActive);
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  focusOnActiveRef.current = focusOnActive;
  isActiveRef.current = isActive;
  onSaveStateChangeRef.current = onSaveStateChange;
  // N-1: 与 App shell 的 <768 断点对齐（useIsMobile 为 min-width:768 的精确取反）
  const isSmallScreen = useIsMobile();

  // 上下文信息按需覆盖显示，不参与正文布局。
  const [rightPanelVisible, setRightPanelVisible] = useState(false);
  // 移动端：上下文面板（大纲/标签）以 inline 子屏形式全屏呈现（移动端契约：禁用 Sheet/抽屉浮层）
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  // 移动端子屏打开时接管 Android 返回键：先关子屏，不退出笔记
  useEffect(() => {
    if (!isSmallScreen || !mobilePanelOpen) return;
    return registerBackHandler(() => {
      setMobilePanelOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isSmallScreen, mobilePanelOpen]);

  const toggleRightPanel = useCallback(() => {
    setRightPanelVisible((visible) => !visible);
  }, []);

  // ========== 状态 ==========
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<VfsError | null>(null);
  
  // 笔记内容状态
  // 🔧 修复：使用 null 表示"未加载"，空字符串表示"已加载但内容为空"
  const [content, setContent] = useState<string | null>(null);
  const [markdownWindow, setMarkdownWindowState] = useState<MarkdownWindow | null>(null);
  const markdownWindowRef = useRef<MarkdownWindow | null>(null);
  const [initialLineWindow, setInitialLineWindow] = useState(DEFAULT_INITIAL_LINE_WINDOW);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // ★ 并发守卫用 ref 而非 state：回调闭包里的 state 可能过期，
  // 也避免 handleRequestLoadMore 随 isLoadingMore 变化重建
  const isLoadingMoreRef = useRef(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const fullContentRef = useRef<string>('');
  // 每次窗口投影变化都推进 revision。保存发起后若又加载了更多内容，
  // 成功回流只能更新持久化基线，不能把编辑器窗口回退到旧快照。
  const markdownWindowRevisionRef = useRef(0);
  const setMarkdownWindow = useCallback((nextWindow: MarkdownWindow | null) => {
    markdownWindowRevisionRef.current += 1;
    markdownWindowRef.current = nextWindow;
    setMarkdownWindowState(nextWindow);
  }, []);
  // ★ R1 修复：记录 content 归属的笔记 ID。
  // SWR 切换笔记时旧内容会短暂保留，若直接传给编辑器会把旧笔记内容
  // 初始化进新笔记的草稿（数据污染）。归属不匹配时编辑器渲染 loading。
  const [contentNoteId, setContentNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState<string>(node.name || '');
  const [tags, setTags] = useState<string[]>((node.metadata?.tags as string[]) || []);
  const editorApiRef = useRef<CrepeEditorApi | null>(null);
  const acrApiByLifecycleRef = useRef(new WeakMap<CrepeEditorApi, CrepeEditorApi>());
  
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
  // 外部 watch 在本窗口 dirty / saving 时只记住新版本，绝不能提前推进
  // expectedUpdatedAt 基线，否则下一次自动保存会静默覆盖外部内容。
  const pendingExternalUpdatedAtRef = useRef<number | null>(null);
  // 维护模式保存拦截的提示节流（自动保存每 1.5s 触发一次，避免通知刷屏）
  const maintenanceWarnedAtRef = useRef(0);
  // ★ F9/R4：正在保存内容的笔记 ID。自身保存触发的 watch 事件无需整页刷新。
  // 按笔记 ID 记录（而非布尔值）：切换笔记时旧笔记的 unmount-flush 保存
  // 仍在途，不应压制新笔记的外部更新刷新。
  const savingContentNoteIdRef = useRef<string | null>(null);

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

    // ★ R3：设置读取可并行；node/content 必须由 OCC-safe helper 顺序读取。
    let nodeResult: Awaited<ReturnType<typeof dstu.get>>;
    let result: Awaited<ReturnType<typeof dstu.getContent>>;
    let settingValue: number;
    try {
      const [snapshot, loadedSettingValue] = await Promise.all([
        readOccSafeNoteSnapshot(node.path),
        loadInitialLineWindowSetting(),
      ]);
      nodeResult = snapshot.nodeResult;
      result = snapshot.contentResult;
      settingValue = loadedSettingValue;
    } catch (unexpected) {
      // dstu API 均为 Result 语义、正常不抛异常；此处兜底防止
      // 意外 throw 让 isLoading 永远卡住（无重试入口的死加载态）
      if (loadingNoteIdRef.current !== currentNoteId) return;
      setError(toVfsError(unexpected, '加载笔记内容失败'));
      setIsLoading(false);
      return;
    }

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
    const nextWindow = projectMarkdownWindow(contentStr, settingValue);

    fullContentRef.current = contentStr;
    setContent(contentStr);
    setContentNoteId(currentNoteId);
    setInitialLineWindow(settingValue);
    setMarkdownWindow(nextWindow);
    isLoadingMoreRef.current = false;
    setIsLoadingMore(false);
    setLoadMoreError(null);
    persistedContentRef.current = contentStr;
    pendingExternalUpdatedAtRef.current = null;
    updateKnownBaseline(freshNode?.updatedAt ?? node.updatedAt ?? null);
    setTitle(freshNode?.name ?? node.name ?? '');
    // 重新加载时同步最新的 tags（node 可能已更新）
    setTags(((freshNode?.metadata?.tags ?? node.metadata?.tags) as string[]) || []);
    setIsLoading(false);
  }, [node.id, node.path, node.name, node.updatedAt, node.metadata?.tags, setMarkdownWindow, updateKnownBaseline]);

  const loadNoteContentRef = useRef(loadNoteContent);
  loadNoteContentRef.current = loadNoteContent;

  useEffect(() => {
    // ★ R4：切换笔记时立即用目标节点的元数据填充侧栏（标题/标签/时间基线），
    // 避免加载期间侧栏短暂显示上一篇笔记的元数据（跨笔记信息串扰）。
    // 加载完成后 loadNoteContent 会用磁盘上的新鲜值覆盖。
    setTitle(node.name || '');
    setTags((node.metadata?.tags as string[]) || []);
    pendingExternalUpdatedAtRef.current = null;
    updateKnownBaseline(node.updatedAt ?? null);
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
    const { nodeResult, contentResult } = await readOccSafeNoteSnapshot(node.path);
    // 防竞态：期间切换了笔记则放弃
    if (loadingNoteIdRef.current !== null && loadingNoteIdRef.current !== currentNoteId) {
      return;
    }
    const diskUpdatedAt = nodeResult.ok && nodeResult.value
      ? (nodeResult.value.updatedAt ?? null)
      : null;
    // 请求发起时可能还是 clean，但 I/O 返回前用户已经开始输入。此时整次
    // 刷新都必须放弃，包括 metadata/baseline/full-content refs。
    if (
      !forceApply &&
      (savingContentNoteIdRef.current === currentNoteId || isContentDirty('note', currentNoteId))
    ) {
      if (diskUpdatedAt !== null) {
        pendingExternalUpdatedAtRef.current = Math.max(
          pendingExternalUpdatedAtRef.current ?? 0,
          diskUpdatedAt,
        );
      }
      return;
    }
    if (!contentResult.ok) {
      if (diskUpdatedAt !== null) {
        pendingExternalUpdatedAtRef.current = Math.max(
          pendingExternalUpdatedAtRef.current ?? 0,
          diskUpdatedAt,
        );
      }
      return;
    }
    if (nodeResult.ok && nodeResult.value) {
      updateKnownBaseline(nodeResult.value.updatedAt ?? lastKnownUpdatedAtRef.current);
      setTitle(nodeResult.value.name || '');
      setTags((nodeResult.value.metadata?.tags as string[]) || []);
      onTitleChangeRef.current?.(nodeResult.value.name || '');
    }
    const latest = typeof contentResult.value === 'string' ? contentResult.value : '';
    const nextWindow = projectMarkdownWindow(latest, initialLineWindow);
    fullContentRef.current = latest;
    setContent(latest);
    setContentNoteId(currentNoteId);
    setMarkdownWindow(nextWindow);
    persistedContentRef.current = latest;
    pendingExternalUpdatedAtRef.current = null;
    // 通知编辑器原位刷新（由 NotesCrepeEditor 监听，带脏检查）
    window.dispatchEvent(new CustomEvent('notes:external-updated', {
      detail: { noteId: currentNoteId, content: nextWindow.loadedMarkdown, force: forceApply },
    }));
  }, [initialLineWindow, node.id, node.path, setMarkdownWindow, updateKnownBaseline]);

  const refreshFromDiskRef = useRef(refreshFromDisk);
  refreshFromDiskRef.current = refreshFromDisk;

  // ★ R3：监听 DSTU watch 事件，外部更新（其他面板/AI 工具/同步）时自动刷新
  useEffect(() => {
    const currentNoteId = node.id;
    const currentNotePath = node.path;
    const unwatch = dstu.watch('*', (event) => {
      // ★ R4：当前笔记被外部删除时立即切换到"不存在"错误态。
      // 之前用户可继续编辑幽灵笔记，直到自动保存反复失败才有噪音提示。
      if (
        (event.type === 'deleted' || event.type === 'purged') &&
        (
          event.node?.id === currentNoteId ||
          event.path === currentNotePath ||
          normalizeResourceInstanceKey(event.path) === currentNoteId
        )
      ) {
        if (isContentDirty('note', currentNoteId)) {
          showGlobalNotification(
            'warning',
            t(
              'notes:editor.deleted_with_unsaved_changes',
              '资源已被删除；窗口保留未保存内容，请复制内容后再关闭。',
            ),
          );
          return;
        }
        setError(new VfsError(VfsErrorCode.NOT_FOUND, 'Note was deleted externally', true, { noteId: currentNoteId }));
        return;
      }
      // 从回收站恢复：自动走出错误态，重新加载（免去用户手动点重试）
      if (
        event.type === 'restored' &&
        (event.node?.id === currentNoteId || event.path === currentNotePath)
      ) {
        void loadNoteContentRef.current();
        return;
      }
      if (event.type !== 'updated' || !event.node) return;
      if (event.node.id !== currentNoteId) return;
      const known = lastKnownUpdatedAtRef.current ?? 0;
      const incoming = event.node.updatedAt ?? 0;
      // 等于/早于已知基线的事件来自自身保存或重复派发，忽略
      if (incoming <= known) return;
      // ★ F9：当前笔记自身保存进行中时跳过刷新。
      // 事件若来自自身保存（emit 先于 invoke 返回），applySuccess 会完成基线同步；
      // 若来自真正的外部更新，进行中的保存会被乐观锁拒绝并走冲突刷新流程。
      // R4：按笔记 ID 比较——旧笔记的在途保存不应压制新笔记的刷新。
      if (
        savingContentNoteIdRef.current === currentNoteId ||
        isContentDirty('note', currentNoteId)
      ) {
        pendingExternalUpdatedAtRef.current = Math.max(
          pendingExternalUpdatedAtRef.current ?? 0,
          incoming,
        );
        return;
      }
      void refreshFromDiskRef.current(false);
    });
    return unwatch;
  }, [node.id, node.path, t, updateKnownBaseline]);

  const handleRequestLoadMore = useCallback(async (
    currentMarkdown: string,
  ): Promise<MarkdownLoadMoreResult | null> => {
    // 内容未加载时 markdownWindowRef 必为 null，无需再检查 content state
    const currentWindow = markdownWindowRef.current;
    if (!currentWindow || !currentWindow.hasMore || isLoadingMoreRef.current) {
      return null;
    }

    setLoadMoreError(null);
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const result = expandMarkdownWindow(
        fullContentRef.current,
        currentMarkdown,
        currentWindow.loadedLineCount,
        getLoadMoreLineChunk(initialLineWindow),
      );
      setMarkdownWindow(result);
      return result;
    } catch (err) {
      console.error('[NoteContentView] Failed to load more markdown lines:', err);
      setLoadMoreError(t('notes:editor.windowing.load_more_failed'));
      return null;
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [initialLineWindow, setMarkdownWindow, t]);

  // ========== 保存回调 ==========
  // 内容保存
  const handleSave = useCallback(async (newContent: string) => {
    if (readOnly) return;
    // S-003: 维护模式拦截，防止 Learning Hub 入口绕过写入。
    // ★ R4：必须 throw（且不可重试）而非静默 return——否则编辑器会把
    // 未写入的内容标记为"已保存"，beforeunload 不再拦截，内容可能丢失。
    if (useSystemStatusStore.getState().maintenanceMode) {
      const msg = t('common:maintenance.blocked_note_save');
      const now = Date.now();
      if (now - maintenanceWarnedAtRef.current > 10_000) {
        maintenanceWarnedAtRef.current = now;
        showGlobalNotification('warning', msg);
      }
      const blocked = new Error(msg);
      (blocked as Error & { isNonRetryable?: boolean }).isNonRetryable = true;
      throw blocked;
    }
    // ★ R4：调用时点快照。切换笔记时编辑器 unmount-flush 会让本次保存
    // 与新笔记的加载并发，await 之后的共享 ref（persistedContentRef 等）
    // 可能已归属新笔记，必须使用保存发起时的快照做冲突判断。
    const savedNoteId = node.id;
    const persistedSnapshot = persistedContentRef.current;
    // 视图状态是否仍归属本次保存的笔记（快速切换后禁止回写视图）
    const isViewStillCurrent = () => loadingNoteIdRef.current === savedNoteId;
    // ★ R3：携带乐观锁基线，防止静默覆盖其他位置的更新
    const currentWindow = markdownWindowRef.current;
    const currentWindowRevision = markdownWindowRevisionRef.current;
    const fullContentSnapshot = fullContentRef.current;
    const saveContent = currentWindow
      ? composeWindowedSave(newContent, fullContentSnapshot, currentWindow.loadedLineCount, currentWindow.hasMore)
      : newContent;
    const applySuccess = (updatedAt?: number) => {
      // ★ R4：磁盘写入已成功；但若用户已切换笔记，绝不能把旧笔记内容
      // 回写进当前视图（会顶掉新笔记的 content/window/基线，编辑器卡骨架屏）
      if (!isViewStillCurrent()) return;
      fullContentRef.current = saveContent;
      setContent(saveContent);
      setContentNoteId(savedNoteId);
      persistedContentRef.current = saveContent;
      if (currentWindow) {
        if (markdownWindowRevisionRef.current !== currentWindowRevision) {
          const liveWindow = markdownWindowRef.current;
          if (liveWindow) {
            const editorMarkdown = editorApiRef.current?.getMarkdown();
            // load-more 已更新 parent ref、但编辑器可能尚未应用返回值；这种
            // 极短窗口内旧 editor markdown 等于保存入参，应采用新投影。
            const liveMarkdown = editorMarkdown && (
              editorMarkdown !== newContent || liveWindow.loadedMarkdown === newContent
            )
              ? editorMarkdown
              : liveWindow.loadedMarkdown;
            const totalLineCount = getMarkdownLineCount(saveContent);
            const previousTotalLineCount = getMarkdownLineCount(fullContentSnapshot);
            const hiddenSuffixLineCount = liveWindow.hasMore
              ? Math.max(0, previousTotalLineCount - liveWindow.loadedLineCount)
              : 0;
            const loadedLineCount = Math.max(0, totalLineCount - hiddenSuffixLineCount);
            setMarkdownWindow({
              loadedMarkdown: liveMarkdown,
              loadedLineCount,
              totalLineCount,
              hasMore: hiddenSuffixLineCount > 0,
            });
          }
        } else if (currentWindow.hasMore) {
          const loadedLineCount = getMarkdownLineCount(newContent);
          const totalLineCount = getMarkdownLineCount(saveContent);
          setMarkdownWindow({
            loadedMarkdown: newContent,
            loadedLineCount,
            totalLineCount,
            hasMore: loadedLineCount < totalLineCount,
          });
        } else {
          const totalLineCount = getMarkdownLineCount(saveContent);
          setMarkdownWindow({
            loadedMarkdown: saveContent,
            loadedLineCount: totalLineCount,
            totalLineCount,
            hasMore: false,
          });
        }
      }
      updateKnownBaseline(updatedAt ?? lastKnownUpdatedAtRef.current);
      if (
        updatedAt !== undefined &&
        (pendingExternalUpdatedAtRef.current ?? 0) <= updatedAt
      ) {
        pendingExternalUpdatedAtRef.current = null;
      }
    };

    savingContentNoteIdRef.current = savedNoteId;
    try {
      const result = await dstu.update(node.path, saveContent, node.type, {
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
        const {
          nodeResult: latestNode,
          contentResult: latestContent,
        } = await readOccSafeNoteSnapshot(node.path);
        const latestStr = latestContent.ok && typeof latestContent.value === 'string'
          ? latestContent.value
          : null;

        if (
          latestNode.ok && latestNode.value &&
          latestStr !== null &&
          // ★ R4：与保存发起时的快照比较（await 后共享 ref 可能已归属新笔记）
          latestStr === persistedSnapshot
        ) {
          if (isViewStillCurrent()) {
            updateKnownBaseline(latestNode.value.updatedAt ?? lastKnownUpdatedAtRef.current);
            setTitle(latestNode.value.name || '');
            setTags((latestNode.value.metadata?.tags as string[]) || []);
          }
          const retry = await dstu.update(node.path, saveContent, node.type, {
            expectedUpdatedAtMs: latestNode.value.updatedAt ?? lastKnownUpdatedAtRef.current ?? undefined,
          });
          if (retry.ok) {
            applySuccess(retry.value.updatedAt);
            return;
          }
        }

        // 真实内容冲突：外部已写入更新版本。以外部版本为准刷新编辑器，
        // 但用户版本不丢弃——通知中提供"恢复我的版本"动作。
        console.warn('[NoteContentView] ⚠️ 保存冲突，刷新为最新版本:', result.error);
        const conflictNoteId = savedNoteId;
        const conflictNotePath = node.path;
        const conflictNoteType = node.type;
        const userVersionFull = saveContent;
        const restoreMine = () => {
          if (isViewStillCurrent()) {
            // 把用户版本写回编辑器（force 路径会同步草稿基线），
            // 并显式入队保存：以已刷新的乐观锁基线覆盖外部版本。
            const userWindow = projectMarkdownWindow(userVersionFull, initialLineWindow);
            fullContentRef.current = userVersionFull;
            setContent(userVersionFull);
            setContentNoteId(conflictNoteId);
            setMarkdownWindow(userWindow);
            persistedContentRef.current = userVersionFull;
            window.dispatchEvent(new CustomEvent('notes:external-updated', {
              detail: { noteId: conflictNoteId, content: userWindow.loadedMarkdown, force: true },
            }));
            window.dispatchEvent(new CustomEvent('notes:request-save', {
              detail: { noteId: conflictNoteId, content: userWindow.loadedMarkdown },
            }));
            return;
          }
          // 用户已切换到其他笔记时，直接以磁盘最新基线恢复原路径。
          void (async () => {
            const latest = await dstu.get(conflictNotePath);
            const expected = latest.ok && latest.value ? latest.value.updatedAt : undefined;
            const restore = await dstu.update(conflictNotePath, userVersionFull, conflictNoteType, {
              expectedUpdatedAtMs: expected ?? undefined,
            });
            if (restore.ok) showGlobalNotification('success', t('notes:actions.save_success'));
            else showGlobalNotification('error', restore.error.toUserMessage());
          })();
        };
        window.dispatchEvent(new CustomEvent('notes:content-conflict', {
          detail: { noteId: conflictNoteId, restoreMine },
        }));
        showGlobalNotification(
          'warning',
          t('notes:editor.conflict_refreshed'),
          undefined,
          {
            action: {
              label: t('notes:editor.conflict_restore_mine'),
              onClick: restoreMine,
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
      // 并发保存（强制保存 + 自动保存）时避免误清对方的标志
      if (savingContentNoteIdRef.current === savedNoteId) {
        savingContentNoteIdRef.current = null;
      }
    }
  }, [initialLineWindow, node.id, node.path, node.type, readOnly, t, refreshFromDisk, setMarkdownWindow, updateKnownBaseline]);

  // 标题变更
  const handleTitleChange = useCallback(async (newTitle: string) => {
    if (readOnly) return;
    // S-003: 维护模式拦截。
    // ★ R4：throw 让 NotesEditorHeader 回滚输入框——静默 return 会让
    // 界面一直显示一个从未持久化的标题。
    if (useSystemStatusStore.getState().maintenanceMode) {
      const msg = t('common:maintenance.blocked_note_save');
      showGlobalNotification('warning', msg);
      throw new Error(msg);
    }
    const savedNoteId = node.id;
    const result = await dstu.setMetadata(node.path, { title: newTitle });
    if (!result.ok) {
      console.error('[NoteContentView] Failed to update title:', result.error);
      reportError(result.error, '更新标题');
      throw new Error(result.error.toUserMessage());
    }
    // ★ R4：await 期间可能已切换笔记，禁止把旧笔记标题回写进当前视图
    if (loadingNoteIdRef.current !== savedNoteId) return;
    setTitle(newTitle);
    // 通知父级面板标题已更新
    onTitleChange?.(newTitle);
  }, [node.id, node.path, readOnly, onTitleChange, t]);

  // 标签变更
  const handleTagsChange = useCallback(async (newTags: string[]) => {
    if (readOnly) return;
    const savedNoteId = node.id;
    const result = await dstu.setMetadata(node.path, { tags: newTags });
    if (!result.ok) {
      console.error('[NoteContentView] Failed to update tags:', result.error);
      reportError(result.error, '更新标签');
      throw new Error(result.error.toUserMessage());
    }
    if (loadingNoteIdRef.current !== savedNoteId) return;
    setTags(newTags);
  }, [node.id, node.path, readOnly]);

  // ★ 关键修复：onEditorReady 必须是稳定引用。
  // NotesCrepeEditor 在该 prop 变化时会先执行 cleanup 调用 onEditorReady(null)，
  // 之前的内联箭头函数导致每次重渲染（含每次自动保存回流 setContent）
  // 都把 editorApiRef 清空，Ctrl+S 强制保存与插入类命令随即静默失效。
  const handleEditorReady = useCallback((api: CrepeEditorApi | null) => {
    editorApiRef.current = api;
    if (api && focusOnActiveRef.current && isActiveRef.current) {
      window.requestAnimationFrame(() => api.focus());
    }
  }, []);

  useEffect(() => {
    if (!focusOnActive || !isActive) return;
    const editor = editorApiRef.current;
    if (editor) window.requestAnimationFrame(() => editor.focus());
  }, [focusOnActive, isActive, node.id]);

  // ACR R1-13：向 noteDriver 注册表挂载/卸载 editorApi（供 agentInsert / probe）
  const handleEditorApiReady = useCallback((api: CrepeEditorApi | null, previousApi?: CrepeEditorApi) => {
    if (api) {
      const getLiveFullMarkdown = () => {
        const visible = api.getMarkdown();
        const currentWindow = markdownWindowRef.current;
        return currentWindow
          ? composeWindowedSave(
              visible,
              fullContentRef.current,
              currentWindow.loadedLineCount,
              currentWindow.hasMore,
            )
          : visible;
      };
      const acrApi: CrepeEditorApi = {
        ...api,
        getFullMarkdown: getLiveFullMarkdown,
        isDocumentWindowed: () => markdownWindowRef.current?.hasMore === true,
        replaceFullMarkdown: async (markdown, options) => {
          if (loadingNoteIdRef.current !== node.id) {
            throw new Error('笔记实例已切换，拒绝写入过期编辑器');
          }
          if (api.isReadonly()) {
            throw new Error('笔记编辑器为只读状态');
          }

          const previousFull = getLiveFullMarkdown();
          const previousBackingFull = fullContentRef.current;
          if (previousFull !== options.expectedMarkdown) {
            throw new Error('笔记正文已变化，全文写入 OCC 校验失败');
          }

          const previousWindow = markdownWindowRef.current;
          const lineCount = getMarkdownLineCount(markdown);
          const fullWindow: MarkdownWindow = {
            loadedMarkdown: markdown,
            loadedLineCount: lineCount,
            totalLineCount: lineCount,
            hasMore: false,
          };

          // Make the editor and save composer operate on the same complete document.
          // Keeping the full document loaded after an ACR mutation is intentional: re-windowing
          // immediately would enqueue a prefix-only onChange before the persisted baseline settles.
          fullContentRef.current = markdown;
          setContent(markdown);
          setContentNoteId(node.id);
          setMarkdownWindow(fullWindow);

          if (!api.setMarkdown(markdown) || api.getMarkdown() !== markdown) {
            fullContentRef.current = previousBackingFull;
            setContent(previousBackingFull);
            setMarkdownWindow(previousWindow);
            if (previousWindow) api.setMarkdown(previousWindow.loadedMarkdown);
            throw new Error('编辑器未确认全文替换');
          }
          if (!api.flushPendingSave) {
            throw new Error('编辑器未提供持久化确认能力');
          }

          await api.flushPendingSave();
          if (persistedContentRef.current !== markdown) {
            throw new Error('笔记全文替换未通过持久化验证');
          }
          return true;
        },
      };
      acrApiByLifecycleRef.current.set(api, acrApi);
      editorApiRef.current = acrApi;
      registerNoteEditor(node.id, acrApi, hostWindowId);
    } else {
      const registeredApi = previousApi
        ? acrApiByLifecycleRef.current.get(previousApi)
        : undefined;
      if (registeredApi && editorApiRef.current === registeredApi) editorApiRef.current = null;
      if (registeredApi) unregisterNoteEditor(node.id, registeredApi, hostWindowId);
    }
  }, [hostWindowId, node.id, setMarkdownWindow]);

  const handleRetryLoadMore = useCallback(() => {
    setLoadMoreError(null);
  }, []);

  // 稳定 windowingState 引用，避免每次渲染生成新对象导致编辑器内
  // 滚动回调链（handleWindowScroll 等）无谓重建
  const editorWindowingState = useMemo(
    () => (markdownWindow ? {
      enabled: true,
      loadedLineCount: markdownWindow.loadedLineCount,
      totalLineCount: markdownWindow.totalLineCount,
      hasMore: markdownWindow.hasMore,
      isLoadingMore,
      loadMoreError,
    } : undefined),
    [markdownWindow, isLoadingMore, loadMoreError],
  );

  useCommandEvents(
    {
      [COMMAND_EVENTS.NOTES_FORCE_SAVE]: () => {
        if (!isActive || readOnly) return;
        const editor = editorApiRef.current;
        if (!editor || editor.isReadonly()) return;
        void handleSave(editor.getMarkdown())
          .then(() => {
            showGlobalNotification('success', t('notes:actions.save_success'));
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : t('notes:actions.save_failed');
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
        showGlobalNotification('info', t('notes:ai.continue_not_available'));
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
  const visibleContent = markdownWindow?.loadedMarkdown ?? (content ?? '');

  // 首次加载直接渲染单内容区骨架，加载完成时内容原位替换，避免布局跳动。

  if (error) {
    const message = error.code === VfsErrorCode.NOT_FOUND
      ? t('notes:error.notFound')
      : error.toUserMessage();
    return (
      <div className="flex flex-col items-center justify-center h-full" role="alert">
        <WarningCircle size={32} className="text-destructive mb-2" aria-hidden="true" />
        <span className="text-destructive">{message}</span>
        <div className="flex gap-2 mt-3">
          <NotionButton variant="primary" onClick={() => loadNoteContent()}>
            {t('common:retry')}
          </NotionButton>
          {onClose && (
            <NotionButton variant="ghost" onClick={onClose}>
              {t('common:close')}
            </NotionButton>
          )}
        </div>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-full bg-background relative overflow-hidden">
      {/* 注意：不能用 role="progressbar"，全局样式会对其强制 min-height:8px，改变此 4px 细条的视觉 */}
      {isLoading && content !== null && (
        <div
          className="absolute top-0 left-0 right-0 h-1 bg-primary/20 z-50 overflow-hidden"
          role="status"
          aria-label={t('notes:editor.windowing.loading_note')}
        >
          {/* 🔧 修复：原引用的 indeterminate 关键帧不存在，进度条从未动画过；
              改用设计系统既有的 progress-indeterminate 关键帧 */}
          <div className="h-full w-2/5 bg-primary animate-[progress-indeterminate_1.5s_ease-in-out_infinite]" />
        </div>
      )}
      <main className="flex-1 min-h-0 flex flex-col" data-note-content-area>
        {isContentReady ? (
          <NotesCrepeEditor
            initialContent={visibleContent}
            initialTitle={title}
            onSave={readOnly ? undefined : handleSave}
            onTitleChange={readOnly ? undefined : handleTitleChange}
            noteId={noteId}
            className="flex-1 min-h-0"
            readOnly={readOnly}
            onEditorReady={handleEditorReady}
            onEditorApiReady={handleEditorApiReady}
            onSaveStateChange={(state) => onSaveStateChangeRef.current?.(state)}
            dirtyRegistryKey={{ typeId: 'note', instanceKey: node.id }}
            acrWindowId={hostWindowId}
            focusModeScopeId={hostWindowId}
            windowingState={editorWindowingState}
            onRequestLoadMore={handleRequestLoadMore}
            onRetryLoadMore={handleRetryLoadMore}
            headerActions={propertiesPanelDisabled ? undefined : (
              <CommonTooltip content={t('notes:contextPanel.title')} position="bottom">
                <NotionButton
                  variant="ghost"
                  iconOnly
                  size="sm"
                  className={cn(
                    'h-7 w-7 text-muted-foreground hover:text-foreground',
                    (rightPanelVisible || mobilePanelOpen) && 'bg-[var(--interactive-hover)] text-foreground',
                  )}
                  onClick={() => isSmallScreen ? setMobilePanelOpen(true) : toggleRightPanel()}
                  aria-label={t('notes:contextPanel.title')}
                  aria-expanded={isSmallScreen ? mobilePanelOpen : rightPanelVisible}
                >
                  <SidebarSimple size={15} aria-hidden="true" />
                </NotionButton>
              </CommonTooltip>
            )}
          />
        ) : (
          <NoteEditorSkeleton label={t('notes:editor.windowing.loading_note')} />
        )}
      </main>

      {!propertiesPanelDisabled && !isSmallScreen && rightPanelVisible && (
        <aside
          className="notes-properties-overlay absolute bottom-3 right-3 top-12 z-30 flex flex-col overflow-hidden border border-border bg-background/98 shadow-md"
          style={{ width: 'min(288px, calc(100% - 24px))' }}
          aria-label={t('notes:contextPanel.title')}
        >
          <div className="flex h-9 flex-shrink-0 items-center justify-between border-b border-border px-2.5">
            <span className="text-xs font-medium text-foreground/80">{t('notes:contextPanel.title')}</span>
            <NotionButton variant="ghost" iconOnly size="sm" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={toggleRightPanel} aria-label={t('common:close')}>
              <X size={13} aria-hidden="true" />
            </NotionButton>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <NotesContextPanel noteId={noteId} title={title} createdAt={node.createdAt} updatedAt={lastKnownUpdatedAt ?? node.updatedAt} tags={tags} content={isContentReady ? visibleContent : ''} onTagsChange={readOnly ? undefined : handleTagsChange} />
          </div>
        </aside>
      )}

      {/* 移动端：上下文 inline 子屏（大纲/标签/元信息）——全屏替换内容 + 顶部返回 + Android 返回键 */}
      {!propertiesPanelDisabled && isSmallScreen && mobilePanelOpen && (
        <div className="absolute inset-0 z-40 flex flex-col bg-background">
          <div className="flex items-center gap-1 px-2 py-1 border-b border-border/40 flex-shrink-0">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setMobilePanelOpen(false)}
              aria-label={t('common:back')}
              className="gap-1 min-h-11 px-2"
            >
              <CaretLeft size={16} aria-hidden="true" />
              {t('common:back')}
            </NotionButton>
            <span className="text-sm font-medium truncate text-foreground/90">
              {t('notes:contextPanel.title')}
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden pb-[var(--mobile-safe-area-bottom,0px)]">
            <NotesContextPanel
              noteId={noteId}
              title={title}
              createdAt={node.createdAt}
              updatedAt={lastKnownUpdatedAt ?? node.updatedAt}
              tags={tags}
              content={isContentReady ? (visibleContent) : ''}
              onTagsChange={readOnly ? undefined : handleTagsChange}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default NoteContentView;
