/**
 * AgentTaskPanel — AI agent 的 builtin todo_list 步骤面板
 *
 * 附着在 chat 输入栏上方，非阻塞式。展开即见全部 steps。
 * 设计语义对齐 composer shell，颜色随主题 palette 联动。
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useStore } from 'zustand';
import {
  ListChecks,
  Check,
  X,
  CircleNotch,
  SkipForward,
  CaretDown,
  CaretUp,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { motion, AnimatePresence } from 'framer-motion';

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
// AgentTaskPanel
// ============================================================================

interface Props {
  store: any;
  className?: string;
}

export const AgentTaskPanel: React.FC<Props> = ({ store, className }) => {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const blocksMap = useStore(store, (s: any) => s.blocks) as Map<string, any> | undefined;

  const { steps, title, isAllDone, message } = useMemo(() => {
    const out: { toolOutput?: unknown; toolName?: string }[] = [];
    blocksMap?.forEach((b) => { if (isTodo(b)) out.push(b); });
    return extractSteps(out);
  }, [blocksMap]);

  const done = steps.filter((s) => s.status === 'completed').length;
  const total = steps.length;
  const running = steps.find((s) => s.status === 'running');
  const has = steps.length > 0;
  const streaming = useStore(store, (s: any) => s.activeBlockIds?.size > 0) ?? false;

  // Auto-expand when new running steps appear
  useEffect(() => {
    if (has && streaming && !expanded && steps.some((s) => s.status === 'running')) {
      setExpanded(true);
    }
  }, [has, streaming, expanded, steps]);

  if (!has) return null;

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
            Expanded steps list (drops below the header bar)
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
              <div className="py-1 max-h-[300px] overflow-y-auto">
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
