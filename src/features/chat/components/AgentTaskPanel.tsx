/**
 * AgentTaskPanel — AI agent 的 builtin todo_list 步骤面板
 *
 * 附着在 chat 输入栏上方，非阻塞式。展开即见全部 steps。
 * 设计语义对齐 composer shell，颜色随主题 palette 联动。
 *
 * 结构化分区（任务侧栏）：
 * 1. 计划 — todo steps 列表（completed/failed/running 可展开查看结果）
 * 2. 来源 — 只显示计数与「在消息中查看」提示（详情收敛到消息级来源面板）
 * 3. 本地 — runtime 环境状态 + 读/写/命令活动（危险操作 destructive 标注）
 * 4. 工作区文件 / 浏览器下载 — 任务结束后的产出物清单
 * 5. 产物 — 笔记/文件 chip（点击在面板中打开）
 * 6. 变更 — 写入/修改摘要（预览 / 撤销 / 存为笔记）
 * 7. 完成 — attempt_completion 总结 + 变更/产物计数一体叙事
 *
 * 数据提取逻辑在 ./agent-task/extractors.ts；分区 UI 在 ./agent-task/*.tsx，
 * 本文件只负责订阅 store 与编排。
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  ListChecks,
  CheckCircle,
  CaretDown,
  CaretUp,
  Notebook,
  FileDoc,
  FileXls,
  FilePpt,
  FilePdf,
  File as FileIcon,
  Globe,
  Brain,
  BookOpen,
  MagnifyingGlass,
  Terminal,
  FolderOpen,
  DownloadSimple,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { DsButton } from '@/components/ui/DsButton';
import { motion, AnimatePresence } from 'framer-motion';
import { openResource } from '@/dstu/openResource';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import type { Block } from '../core/types/block';
import {
  listRuntimeDirectory,
  listTaskBrowserDownloads,
  type RuntimeDirectoryPage,
} from '../api/taskWorkspaceApi';
import type { BrowserDownloadObservation } from '@/features/browser/types';
import type {
  AgentTaskStoreApi,
  ArtifactItem,
  ChangeItem,
  SourceItem,
} from './agent-task/types';
import {
  extractArtifacts,
  extractChangeCoverageIssues,
  extractChanges,
  extractRuntimeEnvironment,
  extractRuntimeItems,
  extractSources,
  extractSteps,
  extractTaskCompletion,
  isRuntimeTool,
  isTodoTool,
  normalizeToolName,
} from './agent-task/extractors';
import { PlanSteps } from './agent-task/PlanSteps';
import { RuntimeSection } from './agent-task/RuntimeSection';
import { ChangesSection } from './agent-task/ChangesSection';

// 兼容既有消费方/测试的提取函数出口（实现已迁移到 agent-task/extractors）
export {
  isChangeProducingTool,
  isRuntimeTool,
  extractChangeCoverageIssues,
} from './agent-task/extractors';

// ============================================================================
// 图标映射
// ============================================================================

const ORIGIN_ICONS: Record<string, Icon> = {
  web_search: Globe,
  memory: Brain,
  rag: BookOpen,
  multimodal: BookOpen,
  tool: MagnifyingGlass,
};

function fileArtifactIcon(toolName: string): Icon {
  const short = toolName.replace('builtin-', '');
  if (short.startsWith('docx_')) return FileDoc;
  if (short.startsWith('xlsx_')) return FileXls;
  if (short.startsWith('pptx_')) return FilePpt;
  if (short === 'paper_save') return FilePdf;
  return FileIcon;
}

// ============================================================================
// Section label
// ============================================================================

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-4 pt-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-[color:var(--text-muted)] select-none">
    {children}
  </div>
);

const SectionDivider: React.FC = () => (
  <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />
);

// ============================================================================
// AgentTaskPanel
// ============================================================================

const EMPTY_BLOCKS: Block[] = [];

interface Props {
  store: AgentTaskStoreApi;
  className?: string;
}

export const AgentTaskPanel: React.FC<Props> = ({ store, className }) => {
  const { t } = useTranslation('chatV2');
  const [expanded, setExpanded] = useState(false);
  // 📱 小屏：面板高度受限 + 不自动展开（避免把输入栏挤出视口）
  const { isSmallScreen } = useBreakpoint();
  const ref = useRef<HTMLDivElement>(null);

  const blocksMap = useStore(store, (s) => s.blocks);
  const sessionId = useStore(store, (s) => s.sessionId);
  const streaming = useStore(store, (s) => (s.activeBlockIds?.size ?? 0) > 0);
  const [workspacePage, setWorkspacePage] = useState<RuntimeDirectoryPage | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [browserDownloads, setBrowserDownloads] = useState<BrowserDownloadObservation[]>([]);

  const loadWorkspacePage = useCallback(async (
    relativePath = '',
    cursor?: string,
    append = false,
  ) => {
    if (!sessionId) return;
    setWorkspaceLoading(true);
    try {
      const page = await listRuntimeDirectory({
        sessionId,
        rootId: 'workspace',
        relativePath,
        cursor,
        limit: 40,
      });
      setWorkspacePage((previous) => append && previous
        ? { ...page, entries: [...previous.entries, ...page.entries] }
        : page);
    } catch {
      setWorkspacePage(null);
    } finally {
      setWorkspaceLoading(false);
    }
  }, [sessionId]);

  const { steps, title, isAllDone, message } = useMemo(() => {
    const out: { toolOutput?: unknown; toolName?: string }[] = [];
    blocksMap?.forEach((b) => { if (isTodoTool(b)) out.push(b); });
    return extractSteps(out);
  }, [blocksMap]);

  // 廉价存在性检查：即使没有 todo 计划，只要用了本地 runtime 工具面板也要出现
  //（只比较 toolName 字符串，流式期间每帧代价可忽略）
  const hasRuntimeActivity = useMemo(() => {
    if (!blocksMap) return false;
    let found = false;
    blocksMap.forEach((b) => {
      if (found) return;
      if (typeof b?.toolName === 'string') {
        const short = normalizeToolName(b.toolName);
        if (isRuntimeTool(b.toolName) || short === 'browser_downloads' || short === 'browser_file_upload') {
          found = true;
        }
      }
    });
    return found;
  }, [blocksMap]);

  // 展开态才做的全量提取：折叠态不展示这些区，
  // 流式期间 blocksMap 每帧变化，无谓的全量重算会被跳过
  const expandedBlocks = useMemo(() => {
    if (!expanded || !blocksMap) return EMPTY_BLOCKS;
    const all: Block[] = [];
    blocksMap.forEach((b) => all.push(b));
    return all;
  }, [blocksMap, expanded]);

  const { sources, artifacts } = useMemo(() => ({
    sources: extractSources(expandedBlocks),
    artifacts: extractArtifacts(expandedBlocks),
  }), [expandedBlocks]);

  const changes = useMemo(() => extractChanges(expandedBlocks), [expandedBlocks]);
  const changeCoverageIssues = useMemo(
    () => extractChangeCoverageIssues(expandedBlocks),
    [expandedBlocks],
  );
  const runtimeItems = useMemo(() => extractRuntimeItems(expandedBlocks), [expandedBlocks]);
  const runtimeEnvironment = useMemo(
    () => extractRuntimeEnvironment(expandedBlocks),
    [expandedBlocks],
  );
  const completion = useMemo(() => extractTaskCompletion(expandedBlocks), [expandedBlocks]);

  const done = steps.filter((s) => s.status === 'completed').length;
  const total = steps.length;
  const running = steps.find((s) => s.status === 'running');
  const has = steps.length > 0;
  const progressPercent = total > 0 ? Math.round((done / total) * 100) : 0;

  useEffect(() => {
    if (!expanded || !sessionId || (has && isAllDone !== true)) return;
    void loadWorkspacePage();
    void listTaskBrowserDownloads(sessionId)
      .then(setBrowserDownloads)
      .catch(() => setBrowserDownloads([]));
  }, [expanded, has, isAllDone, loadWorkspacePage, sessionId]);

  const openArtifact = useCallback((item: ArtifactItem) => {
    if (item.kind === 'note') {
      window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
        detail: { noteId: item.id, source: 'agent_task_panel' },
      }));
    } else {
      void openResource(`/${item.id}`, { handlerNamespace: 'chat-v2' });
    }
  }, []);

  /** 在系统文件管理器中定位 runtime root 内的文件（artifacts/workspace 等）。 */
  const revealRuntimeFile = useCallback(async (item: ChangeItem) => {
    if (!sessionId || !item.rootId || !item.relativePath) return;
    try {
      const absolutePath = await invoke<string>('chat_v2_resolve_runtime_path', {
        sessionId,
        rootId: item.rootId,
        relativePath: item.relativePath,
      });
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(absolutePath);
    } catch (error: unknown) {
      showGlobalNotification(
        'warning',
        t('agentPanel.revealFailed'),
        getErrorMessage(error),
      );
    }
  }, [sessionId, t]);

  const revealResultFile = useCallback(async (rootId: string, relativePath: string) => {
    if (!sessionId) return;
    try {
      const absolutePath = await invoke<string>('chat_v2_resolve_runtime_path', {
        sessionId,
        rootId,
        relativePath,
      });
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(absolutePath);
    } catch (error: unknown) {
      showGlobalNotification('warning', t('agentPanel.revealFailed'), getErrorMessage(error));
    }
  }, [sessionId, t]);

  const openWorkspaceParent = useCallback(() => {
    const current = workspacePage?.relativePath ?? '';
    const parent = current.split('/').filter(Boolean).slice(0, -1).join('/');
    void loadWorkspacePage(parent);
  }, [loadWorkspacePage, workspacePage?.relativePath]);

  // Auto-expand when a NEW running step appears.
  // 只在「进入 running 的步骤发生变化」时展开一次：原实现把 expanded 放进条件里，
  // 用户在步骤仍在 running 时手动折叠会被立刻重新展开，面板收不起来。
  const lastAutoExpandStepRef = useRef<string | null>(null);
  useEffect(() => {
    if (!has || !streaming) return;
    // ★ 高-2 修复：小屏不自动展开（展开态面板会把输入栏挤出视口），
    // 用户仍可通过折叠 pill 手动展开
    if (isSmallScreen) return;
    const runningStep = steps.find((s) => s.status === 'running');
    if (!runningStep) return;
    const stepKey = runningStep.id || runningStep.description;
    if (lastAutoExpandStepRef.current === stepKey) return;
    lastAutoExpandStepRef.current = stepKey;
    setExpanded(true);
  }, [has, streaming, steps, isSmallScreen]);

  if (!has && !hasRuntimeActivity) return null;

  const showSources = sources.length > 0;
  const showArtifacts = artifacts.length > 0;
  const showChanges = changes.length > 0 || changeCoverageIssues.length > 0;
  const showRuntime = runtimeItems.length > 0;
  const showWorkspaceResults = workspacePage !== null;
  const showBrowserDownloads = browserDownloads.length > 0;
  const showSections = showSources || showArtifacts || showChanges || showRuntime
    || showWorkspaceResults || showBrowserDownloads;
  const completionNarrative = completion?.result || message;
  const showCompletion = isAllDone === true && !!(completionNarrative || showChanges || showArtifacts);

  return (
    <div ref={ref} className={cn('w-full px-4 md:px-8 flex-shrink-0 pb-0', className)}>
      <div className="mx-auto max-w-[var(--chat-thread-max-w)]">

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            Collapsed pill / Expanded header bar
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {!expanded && (
          <div
            className={cn(
              'flex w-fit items-center gap-2 h-7 px-2.5',
              'rounded-[var(--radius-shell-control)]',
              'transition-all duration-200 ease-out',
              'bg-transparent hover:bg-[color:var(--interactive-hover)]',
            )}
          >
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(true)}
              aria-expanded={false}
              className="!h-auto !p-0.5 !gap-1.5 !text-xs !font-medium !text-[color:var(--text-secondary)] hover:!text-[color:var(--text-primary)] !border-none !bg-transparent !shadow-none"
            >
              {has ? (
                <ListChecks size={12} className="text-[color:hsl(var(--primary))]" weight="fill" />
              ) : (
                <Terminal size={12} className="text-[color:hsl(var(--primary))]" weight="fill" />
              )}
              {running && (
                <span className="flex-shrink-0 text-2xs font-normal text-[color:var(--text-muted)]">
                  {t('agentPanel.runningPrefix')}
                </span>
              )}
              <span className="truncate max-w-[180px]">
                {running
                  ? running.description
                  : title || (has ? t('agentPanel.plan') : t('agentPanel.environment'))}
              </span>
              <CaretDown size={10} className="text-[color:var(--text-muted)]" />
            </DsButton>

            {has && (
              <>
                {/* 细进度条：done/total（数字计数已在旁，条形只做视觉辅助） */}
                <span
                  className="h-[3px] w-9 flex-shrink-0 overflow-hidden rounded-full bg-[color:var(--border-soft)]"
                  aria-hidden="true"
                >
                  <span
                    className="block h-full rounded-full bg-[color:hsl(var(--primary))]"
                    style={{
                      width: `${progressPercent}%`,
                      transition: 'width var(--chat-motion-base, 200ms) var(--chat-motion-ease, cubic-bezier(0.22, 1, 0.36, 1))',
                    }}
                  />
                </span>
                <span className="text-2xs tabular-nums text-[color:var(--text-muted)] font-medium min-w-[2em] text-right">
                  {done}/{total}
                </span>
              </>
            )}
          </div>
        )}

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            Expanded panel: plan / sources / runtime / results / changes / completion
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
              data-wb-blur-surface
              className={cn(
                'mt-1',
                'w-full overflow-hidden',
                // ★ 高-2 修复：展开态设总高度上限 + 内部滚动，小屏不再把输入栏挤出视口
                'flex max-h-[min(60vh,480px)] flex-col',
                'rounded-[var(--radius-shell-toolbar)]',
                'border border-[color:var(--composer-panel-border)]',
                'bg-[color:var(--composer-panel-surface)]',
                'shadow-[var(--composer-panel-shadow)]',
                'backdrop-blur-[18px] saturate-[140%]',
              )}
            >
              <div className="flex flex-shrink-0 items-center gap-2 px-4 py-2.5">
                {has ? (
                  <ListChecks size={15} className="text-[color:hsl(var(--primary))] flex-shrink-0" />
                ) : (
                  <Terminal size={15} className="text-[color:hsl(var(--primary))] flex-shrink-0" />
                )}
                <span className="text-sm font-semibold text-[color:var(--text-primary)] truncate flex-1 min-w-0">
                  {title || (has ? t('agentPanel.plan') : t('agentPanel.environment'))}
                </span>
                {has && (
                  <span className="text-[11px] tabular-nums text-[color:var(--text-muted)] flex-shrink-0">
                    {done}/{total}
                  </span>
                )}
                <DsButton
                  variant="ghost"
                  onClick={() => setExpanded(false)}
                  // ★ 触控目标：18px 视觉不变，触屏伪元素扩命中区到 ≥44px
                  className="!h-auto !min-w-0 !p-1 !gap-0 !border-none !bg-transparent !shadow-none text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3 [@media(pointer:coarse)]:after:content-['']"
                  aria-label={t('agentPanel.collapsePanel')}
                  aria-expanded={true}
                >
                  <CaretUp size={10} />
                </DsButton>
              </div>
              {/* ★ 高-2：分区内容统一在此容器内滚动（头部保持固定） */}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <SectionDivider />

              {/* ── 区 1：计划（无 todo 计划时整区隐藏，Runtime/Changes 仍可见） ── */}
              {has && showSections && (
                <SectionLabel>{t('agentPanel.plan')}</SectionLabel>
              )}
              {has && <PlanSteps steps={steps} />}

              {/* ── 区 2：来源（信息架构收敛：只显示计数，详情在消息级来源面板） ── */}
              {showSources && (
                <>
                  <SectionDivider />
                  <div className="flex min-w-0 items-center gap-2 px-4 py-2 text-[11px]">
                    <MagnifyingGlass size={12} className="flex-shrink-0 text-[color:var(--text-muted)]" />
                    <span className="flex-shrink-0 font-medium text-[color:var(--text-secondary)]">
                      {t('agentPanel.sources')}
                      <span className="ml-1.5 font-normal tabular-nums">{sources.length}</span>
                    </span>
                    {/* 来源类型概览图标（去重后每类一枚） */}
                    <span className="flex flex-shrink-0 items-center gap-1 text-[color:var(--text-muted)]">
                      {[...new Set(sources.map((s: SourceItem) => s.origin))].slice(0, 4).map((origin) => {
                        const OriginIcon = ORIGIN_ICONS[origin] ?? MagnifyingGlass;
                        return <OriginIcon key={origin} size={11} />;
                      })}
                    </span>
                    <span className="min-w-0 truncate text-[color:var(--text-muted)]">
                      {t('agentPanel.sourcesInMessage')}
                    </span>
                  </div>
                </>
              )}

              {/* ── 区 3：Runtime — Codex 式环境状态行 + 可展开本地活动 ── */}
              {showRuntime && (
                <>
                  <SectionDivider />
                  <RuntimeSection items={runtimeItems} environment={runtimeEnvironment} />
                </>
              )}

              {/* ── 区 4a：工作区文件 ── */}
              {showWorkspaceResults && workspacePage && (
                <>
                  <SectionDivider />
                  <SectionLabel>
                    {t('agentPanel.workspaceFiles')}
                    <span className="ml-1.5 normal-case tracking-normal font-normal">
                      {workspacePage.entries.length}{workspacePage.truncated ? '+' : ''}
                    </span>
                  </SectionLabel>
                  <div className="px-4 pb-2">
                    <div className="flex min-w-0 items-center gap-1 px-2 pb-1 text-2xs text-[color:var(--text-muted)]">
                      {workspacePage.relativePath && (
                        <button type="button" onClick={openWorkspaceParent} className="shrink-0 hover:text-[color:var(--text-primary)]">
                          .. /
                        </button>
                      )}
                      <span className="truncate font-mono">{workspacePage.relativePath || '/'}</span>
                    </div>
                    <div className="max-h-[144px] overflow-y-auto">
                      {workspacePage.entries.map((entry) => {
                        const isDirectory = entry.kind === 'directory';
                        return (
                          <button
                            key={`${entry.kind}:${entry.relativePath}`}
                            type="button"
                            onClick={() => isDirectory
                              ? void loadWorkspacePage(entry.relativePath)
                              : void revealResultFile('workspace', entry.relativePath)}
                            // ★ 触控目标：触屏行高提到 44px（列表内加高只增加滚动量）
                            className="flex h-7 w-full min-w-0 items-center gap-2 rounded-[5px] px-2 text-left text-[11px] hover:bg-[color:var(--interactive-hover)] [@media(pointer:coarse)]:h-11"
                            title={entry.relativePath}
                          >
                            {isDirectory ? <FolderOpen size={12} /> : <FileIcon size={12} />}
                            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                            {entry.sizeBytes != null && (
                              <span className="shrink-0 text-2xs text-[color:var(--text-muted)]">{entry.sizeBytes} B</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {workspacePage.nextCursor && (
                      <button
                        type="button"
                        disabled={workspaceLoading}
                        onClick={() => void loadWorkspacePage(
                          workspacePage.relativePath,
                          workspacePage.nextCursor ?? undefined,
                          true,
                        )}
                        className="mt-1 px-2 text-2xs text-[color:hsl(var(--primary))] disabled:opacity-50"
                      >
                        {workspaceLoading
                          ? t('agentPanel.loadingFiles')
                          : t('agentPanel.loadMoreFiles')}
                      </button>
                    )}
                    {workspacePage.truncated && !workspacePage.nextCursor && (
                      <div className="px-2 pt-1 text-2xs text-[color:var(--text-muted)]">
                        {t('agentPanel.fileTreeTruncated')}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ── 区 4b：浏览器下载 ── */}
              {showBrowserDownloads && (
                <>
                  <SectionDivider />
                  <SectionLabel>
                    {t('agentPanel.browserDownloads')}
                    <span className="ml-1.5 normal-case tracking-normal font-normal">{browserDownloads.length}</span>
                  </SectionLabel>
                  <div className="max-h-[112px] overflow-y-auto px-4 pb-2">
                    {browserDownloads.map((download) => (
                      <button
                        key={download.id}
                        type="button"
                        disabled={download.state !== 'completed'}
                        onClick={() => void revealResultFile(download.rootId, download.relativePath)}
                        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-[5px] px-2 text-left text-[11px] hover:bg-[color:var(--interactive-hover)] disabled:cursor-default disabled:opacity-60"
                        title={download.locator}
                      >
                        <DownloadSimple size={12} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{download.filename}</span>
                        <span className="shrink-0 text-2xs text-[color:var(--text-muted)]">{download.state}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* ── 区 5：产物 ── */}
              {showArtifacts && (
                <>
                  <SectionDivider />
                  <SectionLabel>
                    {t('agentPanel.artifacts')}
                    <span className="ml-1.5 normal-case tracking-normal font-normal">{artifacts.length}</span>
                  </SectionLabel>
                  <div className="flex flex-wrap gap-1.5 px-4 pb-2 max-h-[96px] overflow-y-auto">
                    {artifacts.map((item) => {
                      const ArtifactIcon = item.kind === 'note' ? Notebook : fileArtifactIcon(item.toolName);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => openArtifact(item)}
                          className={cn(
                            'inline-flex items-center gap-1.5 h-6 px-2 max-w-[220px]',
                            'rounded-full border border-[color:var(--border-soft)]',
                            'bg-transparent text-[11px] text-[color:var(--text-secondary)]',
                            'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--text-primary)] cursor-pointer',
                          )}
                          title={item.label}
                        >
                          <ArtifactIcon size={11} className="flex-shrink-0 text-[color:hsl(var(--primary))]" />
                          <span className="truncate">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {/* ── 区 6：变更 ── */}
              {showChanges && (
                <>
                  <SectionDivider />
                  <SectionLabel>
                    {t('agentPanel.changes')}
                    <span className="ml-1.5 normal-case tracking-normal font-normal">{changes.length}</span>
                  </SectionLabel>
                  <ChangesSection
                    changes={changes}
                    coverageIssues={changeCoverageIssues}
                    sessionId={sessionId}
                    onRevealRuntimeFile={(item) => void revealRuntimeFile(item)}
                  />
                </>
              )}

              {/* ── 区 7：完成 — 总结 + 变更/产物计数一体叙事（单一 footer） ── */}
              {showCompletion && (
                <div className="flex-shrink-0 space-y-1 border-t border-[color:var(--composer-panel-border)] px-4 py-2.5">
                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-[color:hsl(var(--success))]">
                    <CheckCircle size={14} weight="fill" />
                    {t('completion.title')}
                  </div>
                  {completionNarrative && (
                    <p className="m-0 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[color:var(--text-secondary)]">
                      {completionNarrative}
                    </p>
                  )}
                  {(showChanges || showArtifacts) && (
                    <div className="flex flex-wrap items-center gap-2 text-2xs text-[color:var(--text-muted)]">
                      {changes.length > 0 && (
                        <span>{t('agentPanel.completionChanges', { count: changes.length })}</span>
                      )}
                      {changes.length > 0 && artifacts.length > 0 && <span aria-hidden="true">·</span>}
                      {artifacts.length > 0 && (
                        <span>{t('agentPanel.completionArtifacts', { count: artifacts.length })}</span>
                      )}
                    </div>
                  )}
                  {completion?.command && (
                    <code className="block w-fit max-w-full truncate rounded bg-[color:var(--interactive-hover)] px-1.5 py-0.5 font-mono text-2xs text-[color:var(--text-secondary)]" title={completion.command}>
                      {completion.command}
                    </code>
                  )}
                </div>
              )}
              </div>{/* ★ 高-2 滚动容器结束 */}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default AgentTaskPanel;
