/**
 * Chat V2 - workbench_ops 工具卡（ACR R1-09 / R2-05）
 *
 * 渲染桌面操控工具（workbench_*）的进度与回执：
 * - 标题 + 工具可读名 + 目标摘要
 * - running / 终态均可按行渲染 block.content 步骤流
 * - 终态解析 AcrReceipt（status / done / undone / message）
 * - 打开目标窗 / 前端平面撤销（账本过期 → 失效态）
 * - data-run-id 与 presence 联动（resolveWorkbenchRunId）
 *
 * 设计见 docs/dev/acr/DESIGN.md §3 / §4.2；规范 docs/dev/acr/STANDARDS.md。
 */

import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowSquareOut,
  Check,
  Desktop,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { PulseDot } from '@/components/ui/PulseDot';
import { TextShimmer } from '../../components/ui/TextShimmer';
import { cn } from '@/utils/cn';
import { getReadableToolName } from '@/features/chat/utils/toolDisplayName';
import {
  isWorkbenchBlockRestored,
  resolveWorkbenchRunId,
} from '@/features/chat/utils/workbenchBlockRemap';
import {
  workbenchBus,
  stageManager,
  usePresenceStore,
  type AcrReceipt,
  type AcrReceiptStatus,
} from '@/features/workbench';
import { runLedger } from '@/features/workbench/agent/ledger';
import { blockRegistry, type BlockComponentProps } from '../../registry';

// ============================================================================
// 解析辅助
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** 从 toolInput 提取 typeId / instanceKey（兼容嵌套 target） */
function extractTarget(toolInput: unknown): { typeId?: string; instanceKey?: string } {
  const input = asRecord(toolInput);
  if (!input) return {};

  const nested = asRecord(input.target);
  const typeId =
    asString(input.typeId) ??
    asString(input.type_id) ??
    asString(nested?.typeId) ??
    asString(nested?.type_id);

  const instanceKey =
    asString(input.instanceKey) ??
    asString(input.instance_key) ??
    asString(input.resourceId) ??
    asString(input.resource_id) ??
    asString(nested?.instanceKey) ??
    asString(nested?.instance_key) ??
    asString(nested?.resourceId) ??
    asString(nested?.resource_id);

  return { typeId, instanceKey };
}

/**
 * 解析工具回执：兼容 `{ result: AcrReceipt }` 与直接 AcrReceipt。
 */
function parseReceipt(toolOutput: unknown): AcrReceipt | null {
  const outer = asRecord(toolOutput);
  if (!outer) return null;

  const candidate = asRecord(outer.result) ?? outer;
  const status = asString(candidate.status) as AcrReceiptStatus | undefined;
  if (
    !status ||
    !['completed', 'partial', 'cancelled', 'failed'].includes(status)
  ) {
    return null;
  }

  const modeRaw = asString(candidate.mode);
  const mode =
    modeRaw === 'frontend' || modeRaw === 'backend' || modeRaw === 'suggestion'
      ? modeRaw
      : 'backend';

  return {
    status,
    mode,
    applied: typeof candidate.applied === 'number' ? candidate.applied : 0,
    totalOps: typeof candidate.totalOps === 'number' ? candidate.totalOps : 0,
    entityIds: asStringArray(candidate.entityIds),
    done: asStringArray(candidate.done),
    undone: asStringArray(candidate.undone),
    userPatch: asString(candidate.userPatch),
    suggestionPending: candidate.suggestionPending === true,
    message: asString(candidate.message),
  };
}

function receiptStatusKey(
  receipt: AcrReceipt | null,
  blockStatus: string
): 'running' | 'success' | 'partial' | 'cancelled' | 'error' {
  if (blockStatus === 'running' || blockStatus === 'pending') return 'running';
  if (!receipt) {
    return blockStatus === 'error' ? 'error' : blockStatus === 'success' ? 'success' : 'running';
  }
  switch (receipt.status) {
    case 'completed':
      return 'success';
    case 'partial':
      return 'partial';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'error';
    default:
      return 'error';
  }
}

// ============================================================================
// 组件
// ============================================================================

const WorkbenchOpsBlock: React.FC<BlockComponentProps> = React.memo(({ block }) => {
  const { t } = useTranslation('chatV2');
  const [undoState, setUndoState] = useState<
    'idle' | 'loading' | 'reverted' | 'incomplete' | 'expired' | 'unavailable'
  >('idle');

  const toolName = block.toolName || '';
  const displayName = useMemo(
    () => (toolName ? getReadableToolName(toolName, t) : t('blocks.mcpTool.unknownTool')),
    [toolName, t]
  );

  const target = useMemo(() => extractTarget(block.toolInput), [block.toolInput]);
  const receipt = useMemo(() => parseReceipt(block.toolOutput), [block.toolOutput]);
  const restoredFromPersistence = isWorkbenchBlockRestored(block.id);
  const statusKey = receiptStatusKey(receipt, block.status);

  const runId = resolveWorkbenchRunId(
    { id: block.id, toolCallId: block.toolCallId },
    (id) => runLedger.hasRun(id)
  );

  // presence 联动：同 runId 的窗口光环状态（只读订阅，驱动 data-presence-status）
  const presenceStatus = usePresenceStore((s) => {
    if (!runId) return undefined;
    for (const p of Object.values(s.byWindow)) {
      if (p.runId === runId) return p.status;
    }
    return undefined;
  });

  const ledgerAlive = Boolean(
    !restoredFromPersistence && runId && runLedger.hasRun(runId)
  );
  const hadReversibleEntry = useRef(false);
  if (ledgerAlive) hadReversibleEntry.current = true;

  const progressSteps = useMemo(() => {
    if (!block.content) return [];
    return block.content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }, [block.content]);

  const targetSummary = useMemo(() => {
    if (!target.typeId) return null;
    return target.instanceKey
      ? `${target.typeId} · ${target.instanceKey}`
      : target.typeId;
  }, [target]);

  const canOpenTarget = Boolean(target.typeId);
  const showUndoChrome =
    receipt?.mode === 'frontend' &&
    (receipt.status === 'completed' || receipt.status === 'partial') &&
    Boolean(runId);

  /** 可点撤销：账本仍持有 invert；过期/已撤 → 失效态 */
  const canUndo =
    showUndoChrome &&
    !restoredFromPersistence &&
    (undoState === 'idle' || undoState === 'incomplete') &&
    ledgerAlive;

  const undoExpired = showUndoChrome && (
    restoredFromPersistence ||
    undoState === 'expired' ||
    (undoState === 'idle' && !ledgerAlive && hadReversibleEntry.current)
  );

  const undoUnavailable = showUndoChrome && (
    undoState === 'unavailable' ||
    (undoState === 'idle' && !ledgerAlive && !undoExpired)
  );

  const showDoneUndone =
    receipt &&
    (receipt.status === 'partial' || receipt.status === 'cancelled') &&
    (receipt.done.length > 0 || receipt.undone.length > 0);

  const showSteps =
    progressSteps.length > 0 &&
    (block.status === 'running' || block.status === 'pending' || Boolean(receipt));

  const handleOpenTarget = () => {
    if (!target.typeId) return;
    const instanceKey = target.instanceKey ?? '';
    void workbenchBus.activate({
      typeId: target.typeId,
      instanceKey,
      action: 'focus',
      fallbackLaunch: {
        typeId: target.typeId,
        instanceKey: target.instanceKey,
        reason: 'api',
      },
    });
  };

  const handleUndo = async () => {
    if (restoredFromPersistence) {
      setUndoState('expired');
      return;
    }
    if (undoState !== 'idle' && undoState !== 'incomplete') return;
    const currentRunId = resolveWorkbenchRunId(
      { id: block.id, toolCallId: block.toolCallId },
      (id) => runLedger.hasRun(id)
    );
    if (!currentRunId || !runLedger.hasRun(currentRunId)) {
      setUndoState(hadReversibleEntry.current ? 'expired' : 'unavailable');
      return;
    }
    setUndoState('loading');
    try {
      const ok = await stageManager.revertRun(currentRunId);
      setUndoState(ok ? 'reverted' : 'incomplete');
    } catch {
      setUndoState('incomplete');
    }
  };

  const statusBadgeClass = {
    running: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    partial: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    cancelled: 'bg-muted text-muted-foreground',
    error: 'bg-destructive/10 text-destructive',
  }[statusKey];

  return (
    <div
      className={cn(
        'rounded-lg border border-border/40',
        'bg-card/40 dark:bg-card/20',
        'overflow-hidden'
      )}
      data-testid="workbench-ops-block"
      data-status={statusKey}
      data-run-id={runId || undefined}
      data-presence-status={presenceStatus || undefined}
    >
      {/* 标题行 */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-border/30">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1.5 rounded-md bg-primary/10 dark:bg-primary/20 flex-shrink-0">
            <Desktop size={16} className="text-primary" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium text-foreground truncate">
              {t('blocks.workbenchOps.title')}
              {displayName ? (
                <span className="text-muted-foreground font-normal"> · {displayName}</span>
              ) : null}
            </span>
            {targetSummary ? (
              <span className="text-xs text-muted-foreground truncate">
                {t('blocks.workbenchOps.target')}: {targetSummary}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground/70">
                {t('blocks.workbenchOps.noTarget')}
              </span>
            )}
          </div>
        </div>

        <span
          className={cn(
            'text-[11px] px-2 py-0.5 rounded-full flex-shrink-0',
            statusBadgeClass
          )}
          data-testid="workbench-ops-status"
        >
          {statusKey === 'running' ? (
            <TextShimmer className="text-[11px]" duration={1.5} spread={3}>
              {t(`blocks.workbenchOps.status.${statusKey}`)}
            </TextShimmer>
          ) : (
            t(`blocks.workbenchOps.status.${statusKey}`)
          )}
        </span>
      </div>

      {/* 步骤流：running 始终展示区；终态有 content 行时保留摘要 */}
      {(block.status === 'running' || block.status === 'pending' || showSteps) && (
        <div className="px-3 py-2 border-b border-border/20" data-testid="workbench-ops-steps">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1.5">
            {(block.status === 'running' || block.status === 'pending') && (
              <PulseDot className="w-1.5 h-1.5 text-primary" />
            )}
            <span>{t('blocks.workbenchOps.steps')}</span>
          </div>
          {progressSteps.length > 0 ? (
            <ul className="space-y-1 max-h-40 overflow-auto">
              {progressSteps.map((step, index) => (
                <li
                  key={`${index}-${step.slice(0, 24)}`}
                  className="text-xs text-muted-foreground font-mono leading-relaxed pl-3 border-l border-border/40"
                >
                  {step}
                </li>
              ))}
            </ul>
          ) : (
            <TextShimmer className="text-xs text-muted-foreground" duration={1.5} spread={3}>
              {t('blocks.workbenchOps.status.running')}
            </TextShimmer>
          )}
        </div>
      )}

      {/* 结果区 */}
      {receipt && block.status !== 'running' && block.status !== 'pending' && (
        <div className="px-3 py-2 space-y-2" data-testid="workbench-ops-receipt">
          {showDoneUndone ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <div className="flex items-center gap-1 text-xs font-medium text-success mb-1">
                  <Check size={12} />
                  {t('blocks.workbenchOps.done')}
                </div>
                <ul className="space-y-0.5">
                  {receipt.done.length === 0 ? (
                    <li className="text-xs text-muted-foreground/60">—</li>
                  ) : (
                    receipt.done.map((item, i) => (
                      <li key={`done-${i}`} className="text-xs text-muted-foreground">
                        {item}
                      </li>
                    ))
                  )}
                </ul>
              </div>
              <div>
                <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                  <XCircle size={12} />
                  {t('blocks.workbenchOps.pending')}
                </div>
                <ul className="space-y-0.5">
                  {receipt.undone.length === 0 ? (
                    <li className="text-xs text-muted-foreground/60">—</li>
                  ) : (
                    receipt.undone.map((item, i) => (
                      <li key={`undone-${i}`} className="text-xs text-muted-foreground">
                        {item}
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </div>
          ) : receipt.done.length > 0 ? (
            <ul className="space-y-0.5">
              {receipt.done.map((item, i) => (
                <li key={`done-${i}`} className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <Check size={12} className="text-success mt-0.5 flex-shrink-0" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {receipt.message ? (
            <p className="text-xs text-muted-foreground border-t border-border/20 pt-2">
              <span className="font-medium">{t('blocks.workbenchOps.message')}: </span>
              {receipt.message}
            </p>
          ) : null}

          {receipt.applied > 0 || receipt.totalOps > 0 ? (
            <p className="text-[11px] text-muted-foreground/70" data-testid="workbench-ops-applied">
              {t('blocks.workbenchOps.applied', {
                applied: receipt.applied,
                total: receipt.totalOps,
              })}
            </p>
          ) : null}
        </div>
      )}

      {/* 错误（无 receipt 时） */}
      {block.status === 'error' && !receipt && (
        <div className="px-3 py-2 flex items-center gap-1.5 text-xs text-destructive">
          <WarningCircle size={14} />
          {block.error || t('blocks.mcpTool.unknownError')}
        </div>
      )}

      {/* 按钮栏 */}
      {(canOpenTarget || showUndoChrome) && (
        <div className="flex flex-wrap gap-2 px-3 py-2.5 border-t border-border/50">
          {canOpenTarget && (
            <NotionButton
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpenTarget}
              className="text-xs sm:text-sm bg-muted/30 hover:bg-[var(--interactive-hover)] gap-1.5"
              data-testid="workbench-ops-open"
            >
              <ArrowSquareOut size={12} />
              {t('blocks.workbenchOps.openTarget')}
            </NotionButton>
          )}

          {showUndoChrome && (
            <NotionButton
              type="button"
              variant="default"
              size="sm"
              onClick={() => void handleUndo()}
              disabled={!canUndo}
              className="text-xs sm:text-sm gap-1.5"
              data-testid="workbench-ops-undo"
              title={
                undoExpired
                  ? t('blocks.workbenchOps.undoExpired')
                  : undoUnavailable
                    ? t('blocks.workbenchOps.undoUnavailable', {
                        defaultValue: '撤销不可用（没有可恢复的更改）',
                      })
                    : undoState === 'incomplete'
                      ? ledgerAlive
                        ? t('blocks.workbenchOps.undoRetry', {
                            defaultValue: '部分更改未恢复，可再次尝试撤销',
                          })
                        : t('blocks.workbenchOps.undoIncompleteExhausted', {
                            defaultValue: '撤销未完全完成，且没有可重试的更改',
                          })
                      : undefined
              }
            >
              {undoState === 'reverted' ? (
                <>
                  <Check size={12} className="text-emerald-500" />
                  {t('blocks.workbenchOps.undoApplied', {
                    defaultValue: '已撤销可恢复更改',
                  })}
                </>
              ) : undoState === 'incomplete' ? (
                ledgerAlive ? (
                  t('blocks.workbenchOps.undoRetry', {
                    defaultValue: '部分撤销，重试',
                  })
                ) : (
                  t('blocks.workbenchOps.undoIncompleteExhausted', {
                    defaultValue: '撤销未完全完成（无法重试）',
                  })
                )
              ) : undoExpired ? (
                t('blocks.workbenchOps.undoExpired')
              ) : undoUnavailable ? (
                t('blocks.workbenchOps.undoUnavailable', {
                  defaultValue: '不可撤销',
                })
              ) : undoState === 'loading' ? (
                t('blocks.workbenchOps.undoing', {
                  defaultValue: '正在撤销…',
                })
              ) : (
                t('blocks.workbenchOps.undo')
              )}
            </NotionButton>
          )}
        </div>
      )}
    </div>
  );
});

WorkbenchOpsBlock.displayName = 'WorkbenchOpsBlock';

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('workbench_ops', {
  type: 'workbench_ops',
  component: WorkbenchOpsBlock,
  onAbort: 'keep-content',
});

export { WorkbenchOpsBlock };
