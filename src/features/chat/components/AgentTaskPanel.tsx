/**
 * AgentTaskPanel — AI agent 的 builtin todo_list 步骤面板
 *
 * 附着在 chat 输入栏上方，非阻塞式。展开即见全部 steps。
 * 设计语义对齐 composer shell，颜色随主题 palette 联动。
 *
 * 结构化四区（对标 Codex 任务侧栏）：
 * 1. 计划 — todo steps 列表
 * 2. 来源 — 检索/搜索引用（复用 sourceAdapter，可点击溯源）
 * 3. 产物 — 笔记/文件 chip（点击在面板中打开）
 * 4. 摘要 — 全部完成后的总结语
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import {
  ListChecks,
  Check,
  X,
  CircleNotch,
  SkipForward,
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
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { motion, AnimatePresence } from 'framer-motion';
import { openUrl } from '@/utils/urlOpener';
import { openResource } from '@/dstu/openResource';
import { blocksToSourceBundle } from './panels/sourceAdapter';
import type { Block } from '../core/types/block';

// ============================================================================
// Inline types & helpers
// ============================================================================

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

interface Step {
  id: string;
  description: string;
  status: StepStatus;
  result?: string;
  createdAt: number;
  updatedAt?: number;
}

interface TodoOutput {
  success: boolean;
  todoListId?: string;
  title?: string;
  steps?: Step[];
  isAllDone?: boolean;
  message?: string;
}

const TODO_TOOL_SET = new Set([
  'todo_init', 'todo_update', 'todo_add', 'todo_get',
  'builtin-todo_init', 'builtin-todo_update', 'builtin-todo_add', 'builtin-todo_get',
]);

function isTodo(block: { toolName?: string }) {
  return typeof block.toolName === 'string' ? TODO_TOOL_SET.has(block.toolName) : false;
}

function extractSteps(blocks: { toolOutput?: unknown; toolName?: string }[]) {
  let steps: Step[] = [];
  let title: string | undefined;
  let isAllDone: boolean | undefined;
  let message: string | undefined;
  for (const b of blocks) {
    const out = b.toolOutput as TodoOutput | { result?: TodoOutput } | undefined;
    if (!out) continue;
    const d = (out as { result?: TodoOutput }).result || (out as TodoOutput);
    if (d.steps?.length) { steps = d.steps; title = d.title || title; isAllDone = d.isAllDone; message = d.message; }
    else if (d.title) title = d.title;
    if (d.isAllDone !== undefined) isAllDone = d.isAllDone;
    if (d.message) message = d.message;
  }
  return { steps, title, isAllDone, message };
}

// ============================================================================
// 来源 & 产物提取
// ============================================================================

interface SourceItem {
  id: string;
  title: string;
  url?: string;
  resourceId?: string;
  origin: string;
}

interface ArtifactItem {
  id: string;
  kind: 'note' | 'file';
  label: string;
  toolName: string;
}

const ORIGIN_ICONS: Record<string, Icon> = {
  web_search: Globe,
  memory: Brain,
  rag: BookOpen,
  multimodal: BookOpen,
  tool: MagnifyingGlass,
};

/** 笔记写入类工具（产生/修改笔记，视为产物） */
const NOTE_WRITE_TOOLS = new Set([
  'note_create', 'note_append', 'note_replace', 'note_set',
  'builtin-note_create', 'builtin-note_append', 'builtin-note_replace', 'builtin-note_set',
]);

/** 文件生成类工具名后缀（docx/xlsx/pptx 创建编辑 + 论文保存） */
function isFileProducingTool(toolName: string): boolean {
  const short = toolName.replace('builtin-', '');
  return (
    short.startsWith('docx_') ||
    short.startsWith('xlsx_') ||
    short.startsWith('pptx_') ||
    short === 'paper_save'
  );
}

function fileArtifactIcon(toolName: string): Icon {
  const short = toolName.replace('builtin-', '');
  if (short.startsWith('docx_')) return FileDoc;
  if (short.startsWith('xlsx_')) return FileXls;
  if (short.startsWith('pptx_')) return FilePpt;
  if (short === 'paper_save') return FilePdf;
  return FileIcon;
}

/** 从成功的工具块中提取产物（笔记 + 生成文件） */
function extractArtifacts(blocks: Block[]): ArtifactItem[] {
  const artifacts = new Map<string, ArtifactItem>();

  for (const block of blocks) {
    if (block.status !== 'success' || !block.toolName) continue;
    const out = (block.toolOutput ?? {}) as Record<string, unknown>;
    // 兼容 { result: {...} } 包装
    const d = (typeof out.result === 'object' && out.result !== null
      ? out.result
      : out) as Record<string, unknown>;

    if (NOTE_WRITE_TOOLS.has(block.toolName)) {
      const noteId = (d.note_id || d.noteId || d.id ||
        block.toolInput?.noteId || block.toolInput?.note_id) as string | undefined;
      if (!noteId) continue;
      const label = (d.title || block.toolInput?.title || d.noteTitle) as string | undefined;
      artifacts.set(noteId, {
        id: noteId,
        kind: 'note',
        label: label || noteId,
        toolName: block.toolName,
      });
    } else if (isFileProducingTool(block.toolName)) {
      const fileId = (d.file_id || d.new_file_id) as string | undefined;
      if (!fileId) continue;
      const label = (d.file_name || d.title) as string | undefined;
      artifacts.set(fileId, {
        id: fileId,
        kind: 'file',
        label: label || fileId,
        toolName: block.toolName,
      });
    }
  }

  return [...artifacts.values()];
}

/** 从成功块中提取来源（复用 sourceAdapter 的解析逻辑），按 title+url 去重 */
function extractSources(blocks: Block[]): SourceItem[] {
  const successBlocks = blocks.filter((b) => b.status === 'success');
  const bundle = blocksToSourceBundle(successBlocks);
  if (!bundle) return [];

  const seen = new Set<string>();
  const items: SourceItem[] = [];
  for (const group of bundle.groups) {
    for (const item of group.items) {
      const dedupeKey = `${item.title}::${item.link ?? ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      items.push({
        id: item.id,
        title: item.title,
        url: item.link,
        resourceId: item.resourceId || item.sourceId,
        origin: item.origin,
      });
    }
  }
  return items;
}

// ============================================================================
// StatusDot
// ============================================================================

const StatusDot: React.FC<{ status: StepStatus; index: number }> = ({ status, index }) => {
  switch (status) {
    case 'running':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-[color:hsl(var(--primary))] text-[color:hsl(var(--primary-foreground))] text-[10px] font-bold flex-shrink-0">
          {index + 1}
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0 text-[color:hsl(var(--success))]">
          <Check size={14} weight="bold" />
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0 text-[color:hsl(var(--destructive))]">
          <X size={13} weight="bold" />
        </span>
      );
    case 'skipped':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0 text-[color:var(--text-muted)]">
          <SkipForward size={12} />
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border border-[color:var(--border-soft)] flex-shrink-0" />
      );
  }
};

// ============================================================================
// Section label
// ============================================================================

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] select-none">
    {children}
  </div>
);

// ============================================================================
// AgentTaskPanel
// ============================================================================

interface Props {
  store: any;
  className?: string;
}

export const AgentTaskPanel: React.FC<Props> = ({ store, className }) => {
  const { t } = useTranslation('chatV2');
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const blocksMap = useStore(store, (s: any) => s.blocks) as Map<string, any> | undefined;

  const { steps, title, isAllDone, message } = useMemo(() => {
    const out: { toolOutput?: unknown; toolName?: string }[] = [];
    blocksMap?.forEach((b) => { if (isTodo(b)) out.push(b); });
    return extractSteps(out);
  }, [blocksMap]);

  // 来源 + 产物（仅在面板展开且存在计划时才提取：折叠态不展示这两个区，
  // 流式期间 blocksMap 每帧变化，无谓的全量重算会被跳过）
  const { sources, artifacts } = useMemo(() => {
    if (!expanded || !steps.length || !blocksMap) return { sources: [], artifacts: [] };
    const all: Block[] = [];
    blocksMap.forEach((b) => all.push(b));
    return {
      sources: extractSources(all),
      artifacts: extractArtifacts(all),
    };
  }, [blocksMap, steps.length, expanded]);

  const done = steps.filter((s) => s.status === 'completed').length;
  const total = steps.length;
  const running = steps.find((s) => s.status === 'running');
  const has = steps.length > 0;
  const streaming = useStore(store, (s: any) => s.activeBlockIds?.size > 0) ?? false;

  const openSource = useCallback((item: SourceItem) => {
    if (item.url && (item.url.startsWith('http://') || item.url.startsWith('https://'))) {
      void openUrl(item.url);
    } else if (item.resourceId) {
      void openResource(`/${item.resourceId}`, { handlerNamespace: 'chat-v2' });
    }
  }, []);

  const openArtifact = useCallback((item: ArtifactItem) => {
    if (item.kind === 'note') {
      window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
        detail: { noteId: item.id, source: 'agent_task_panel' },
      }));
    } else {
      void openResource(`/${item.id}`, { handlerNamespace: 'chat-v2' });
    }
  }, []);

  // Auto-expand when new running steps appear
  useEffect(() => {
    if (has && streaming && !expanded && steps.some((s) => s.status === 'running')) {
      setExpanded(true);
    }
  }, [has, streaming, expanded, steps]);

  if (!has) return null;

  const showSources = sources.length > 0;
  const showArtifacts = artifacts.length > 0;
  const showSections = showSources || showArtifacts;

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
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(true)}
              className="!h-auto !p-0.5 !gap-1.5 !text-xs !font-medium !text-[color:var(--text-secondary)] hover:!text-[color:var(--text-primary)] !border-none !bg-transparent !shadow-none"
            >
              <ListChecks size={12} className="text-[color:hsl(var(--primary))]" weight="fill" />
              <span className="truncate max-w-[180px]">
                {running ? running.description : title || 'Plan'}
              </span>
              <CaretDown size={10} className="text-[color:var(--text-muted)]" />
            </NotionButton>

            <span className="text-[10px] tabular-nums text-[color:var(--text-muted)] font-medium min-w-[2em] text-right">
              {done}/{total}
            </span>
          </div>
        )}

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            Expanded panel: plan / sources / artifacts / summary
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                'mt-1',
                'w-full overflow-hidden',
                'rounded-[var(--radius-shell-toolbar)]',
                'border border-[color:var(--composer-panel-border)]',
                'bg-[color:var(--composer-panel-surface)]',
                'shadow-[var(--composer-panel-shadow)]',
                'backdrop-blur-[18px] saturate-[140%]',
              )}
            >
              <div className="flex items-center gap-2 px-4 py-2.5">
                <ListChecks size={15} className="text-[color:hsl(var(--primary))] flex-shrink-0" />
                <span className="text-sm font-semibold text-[color:var(--text-primary)] truncate flex-1 min-w-0">
                  {title || 'Plan'}
                </span>
                <span className="text-[11px] tabular-nums text-[color:var(--text-muted)] flex-shrink-0">
                  {done}/{total}
                </span>
                <NotionButton
                  variant="ghost"
                  onClick={() => setExpanded(false)}
                  className="!h-auto !min-w-0 !p-1 !gap-0 !border-none !bg-transparent !shadow-none text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                  aria-label="Collapse"
                >
                  <CaretUp size={10} />
                </NotionButton>
              </div>
              <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />

              {/* ── 区 1：计划 ── */}
              {showSections && (
                <SectionLabel>{t('agentPanel.plan', '计划')}</SectionLabel>
              )}
              <div className="py-1 max-h-[260px] overflow-y-auto">
                {steps.map((step, idx) => (
                  <div
                    key={step.id || idx}
                    className={cn(
                      'flex items-start gap-2.5 mx-1 px-3 py-[7px] rounded-[10px]',
                      'transition-colors duration-100',
                      'hover:bg-[color:var(--interactive-hover)]',
                    )}
                  >
                    <StatusDot status={step.status} index={idx} />
                    <div className="flex-1 min-w-0">
                      <span
                        className={cn(
                          'block text-[13px] leading-snug',
                          step.status === 'completed' && 'line-through text-[color:hsl(var(--success))] opacity-70',
                          step.status === 'running' && 'text-[color:var(--text-primary)] font-medium',
                          step.status === 'failed' && 'text-[color:hsl(var(--destructive))]',
                          step.status === 'skipped' && 'text-[color:var(--text-muted)] line-through',
                          step.status === 'pending' && 'text-[color:var(--text-muted)]',
                        )}
                      >
                        {step.description}
                      </span>
                      {step.status === 'failed' && step.result && (
                        <span className="block text-[11px] text-[color:hsl(var(--destructive))] opacity-60 mt-0.5">
                          {step.result}
                        </span>
                      )}
                    </div>
                    {step.status === 'running' && (
                      <CircleNotch size={13} className="animate-spin text-[color:hsl(var(--primary))] flex-shrink-0 mt-[3px]" />
                    )}
                  </div>
                ))}
              </div>

              {/* ── 区 2：来源 ── */}
              {showSources && (
                <>
                  <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />
                  <SectionLabel>
                    {t('agentPanel.sources', '来源')}
                    <span className="ml-1.5 normal-case tracking-normal font-normal">{sources.length}</span>
                  </SectionLabel>
                  {/* 容器本身可滚动，渲染全部来源，保证与计数一致 */}
                  <div className="flex flex-wrap gap-1.5 px-4 pb-2 max-h-[96px] overflow-y-auto">
                    {sources.map((item) => {
                      const OriginIcon = ORIGIN_ICONS[item.origin] ?? MagnifyingGlass;
                      const clickable = !!(item.url || item.resourceId);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => clickable && openSource(item)}
                          className={cn(
                            'inline-flex items-center gap-1.5 h-6 px-2 max-w-[220px]',
                            'rounded-full border border-[color:var(--border-soft)]',
                            'bg-transparent text-[11px] text-[color:var(--text-secondary)]',
                            clickable
                              ? 'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--text-primary)] cursor-pointer'
                              : 'cursor-default opacity-70',
                          )}
                          title={item.title}
                        >
                          <OriginIcon size={11} className="flex-shrink-0 text-[color:var(--text-muted)]" />
                          <span className="truncate">{item.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {/* ── 区 3：产物 ── */}
              {showArtifacts && (
                <>
                  <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />
                  <SectionLabel>
                    {t('agentPanel.artifacts', '产物')}
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

              {/* ── 区 4：摘要 ── */}
              {isAllDone && message && (
                <div className="flex-shrink-0 px-4 py-2 border-t border-[color:var(--composer-panel-border)] opacity-60">
                  <span className="text-[11px] text-[color:hsl(var(--success))] font-medium">{message}</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default AgentTaskPanel;
