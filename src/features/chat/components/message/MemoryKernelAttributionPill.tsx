import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Brain, Trash, X } from '@phosphor-icons/react';
import {
  inspectMemoryKernel,
  mutateMemoryKernel,
  type MemoryInspectionView,
} from '@/api/memoryApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { cn } from '@/lib/utils';

// Shared module-level cache so 50 assistant bubbles in a conversation trigger at most 1 RPC.
let cachedView: MemoryInspectionView | null = null;
let cachedAt = 0;
let inflight: Promise<MemoryInspectionView | null> | null = null;
const CACHE_TTL_MS = 15_000;
const listeners = new Set<() => void>();

function notifyAll(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): MemoryInspectionView | null {
  return cachedView;
}

export function invalidateMemoryKernelAttributionCache(next?: MemoryInspectionView | null): void {
  if (next !== undefined) {
    cachedView = next;
    cachedAt = Date.now();
  } else {
    cachedAt = 0;
  }
  notifyAll();
}

async function ensureMemoryKernelSummary(): Promise<MemoryInspectionView | null> {
  if (cachedView && Date.now() - cachedAt < CACHE_TTL_MS) return cachedView;
  if (inflight) return inflight;
  inflight = inspectMemoryKernel()
    .then((view) => {
      if (view && typeof view === 'object' && view.hardRules && view.learnerProfile) {
        cachedView = view;
        cachedAt = Date.now();
        notifyAll();
        return view;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export interface MemoryKernelAttributionPillProps {
  className?: string;
}

export const MemoryKernelAttributionPill: React.FC<MemoryKernelAttributionPillProps> = ({ className }) => {
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [lastRemovedRule, setLastRemovedRule] = useState<{ instruction: string; scope: string; pinned: boolean } | null>(null);

  useEffect(() => {
    void ensureMemoryKernelSummary();
  }, []);

  if (!view || view.privacyMode) return null;
  const rules = view.hardRules?.rules ?? [];
  const weakPoints = view.learnerProfile?.weak_points ?? [];
  const totalCount = rules.length + weakPoints.length;
  if (totalCount === 0 && !lastRemovedRule) return null;

  const handleRemoveRule = async (id: string) => {
    const targetRule = rules.find((r) => r.id === id);
    setBusyKey(`rule:${id}`);
    try {
      const updated = await mutateMemoryKernel({ kind: 'remove_rule', idOrInstruction: id });
      invalidateMemoryKernelAttributionCache(updated);
      if (targetRule) {
        setLastRemovedRule({ instruction: targetRule.instruction, scope: targetRule.scope, pinned: targetRule.pinned });
      }
      showGlobalNotification('success', '已从记忆内核移除该规则（下轮立即生效）');
    } catch {
      showGlobalNotification('error', '移除规则失败');
    } finally {
      setBusyKey(null);
    }
  };

  const handleUndoRemovedRule = async () => {
    if (!lastRemovedRule) return;
    setBusyKey('rule:undo');
    try {
      const updated = await mutateMemoryKernel({
        kind: 'upsert_rule',
        input: {
          instruction: lastRemovedRule.instruction,
          scope: lastRemovedRule.scope,
          origin: 'user_explicit',
          pinned: lastRemovedRule.pinned,
        },
      });
      invalidateMemoryKernelAttributionCache(updated);
      setLastRemovedRule(null);
      showGlobalNotification('success', '已恢复刚才删除的规则');
    } catch {
      showGlobalNotification('error', '恢复规则失败');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveWeakPoint = async (subject: string, knowledgePoint: string) => {
    setBusyKey(`wp:${subject}:${knowledgePoint}`);
    try {
      const updated = await mutateMemoryKernel({
        kind: 'update_profile',
        update: {
          weak_points_add: [],
          weak_points_remove: [{ subject, knowledge_point: knowledgePoint }],
          goals_add: [],
          goals_remove: [],
        },
      });
      invalidateMemoryKernelAttributionCache(updated);
      showGlobalNotification('success', `已移除薄弱点「${knowledgePoint}」`);
    } catch {
      showGlobalNotification('error', '移除薄弱点失败');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className={cn('relative inline-flex items-center', className)}>
      <button
        type="button"
        data-testid="memory-kernel-attribution-pill"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground',
          open && 'border-primary/50 bg-primary/10 text-primary',
        )}
        title="查看本轮已注入的长期记忆规则与薄弱点，支持一键修正或忘掉"
      >
        <Brain className="h-3 w-3 shrink-0" />
        <span>
          记忆内核 · {rules.length > 0 ? `${rules.length} 规则` : ''}
          {rules.length > 0 && weakPoints.length > 0 ? ' / ' : ''}
          {weakPoints.length > 0 ? `${weakPoints.length} 薄弱点` : ''}
        </span>
      </button>

      {open && (
        <div
          data-testid="memory-kernel-attribution-popover"
          className="absolute bottom-full left-0 z-40 mb-1.5 w-80 max-w-[90vw] rounded-xl border border-border/70 bg-popover p-3 text-xs text-popover-foreground shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-medium">
              <Brain className="h-3.5 w-3.5 text-primary" />
              <span>已生效记忆内核（本会话冻结）</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="关闭"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {rules.length > 0 && (
            <div className="mb-2 space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">L1 硬规则（每次新会话首轮生效）</div>
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-start justify-between gap-2 rounded-md border border-border/40 bg-muted/30 px-2 py-1.5"
                >
                  <span className="leading-snug text-foreground/90">{rule.instruction}</span>
                  <button
                    type="button"
                    disabled={busyKey === `rule:${rule.id}`}
                    onClick={() => void handleRemoveRule(rule.id)}
                    className="shrink-0 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`忘掉这条规则：${rule.instruction.slice(0, 24)}`}
                    title="忘掉这条规则"
                  >
                    <Trash className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {lastRemovedRule && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-[11px]">
              <span className="truncate">已移除：{lastRemovedRule.instruction}</span>
              <button
                type="button"
                disabled={busyKey === 'rule:undo'}
                onClick={() => void handleUndoRemovedRule()}
                className="shrink-0 font-medium text-primary hover:underline"
              >
                撤销
              </button>
            </div>
          )}

          {weakPoints.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">L2 活跃薄弱点</div>
              {weakPoints.slice(0, 5).map((wp) => {
                const key = `${wp.subject}:${wp.knowledge_point}`;
                return (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/40 bg-muted/30 px-2 py-1"
                  >
                    <span className="truncate">
                      <span className="text-muted-foreground">[{wp.subject}]</span> {wp.knowledge_point}
                    </span>
                    <button
                      type="button"
                      disabled={busyKey === `wp:${key}`}
                      onClick={() => void handleRemoveWeakPoint(wp.subject, wp.knowledge_point)}
                      className="shrink-0 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      title="标记已掌握 / 忘掉"
                    >
                      <Trash className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
