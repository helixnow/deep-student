/**
 * Chat V2 - workbench_ops 工具卡（ACR R1-09 / R2-05）
 *
 * 渲染桌面操控工具（workbench_*）的进度与回执：
 * - 标题 + 工具可读名 + 目标摘要
 * - running / 终态均可按行渲染 block.content 步骤流
 * - 终态解析旧 AcrReceipt 与 ACR 2.0 AgentActReceipt
 * - 打开目标窗 / 持久 undoToken 优先撤销 / 旧内存账本兼容
 * - data-run-id 与 presence 联动（resolveWorkbenchRunId）
 *
 * 设计见 docs/dev/acr/DESIGN.md §3 / §4.2；规范 docs/dev/acr/STANDARDS.md。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from '@/features/chat/utils/workbenchBlockRemap';
import {
  workbenchBus,
  stageManager,
  usePresenceStore,
  makeAcrSessionRunId,
  type AcrReceipt,
  type AcrReceiptStatus,
} from '@/features/workbench';
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

let uiUndoSequence = 0;

function nextUiUndoNonce(): string {
  uiUndoSequence += 1;
  return `${Date.now().toString(36)}-${uiUndoSequence.toString(36)}`;
}

/** ACR 4.0（A2）：desktop 是无宿主窗口的虚拟目标，「打开目标窗」对它无意义 */
const VIRTUAL_TARGET_TYPE_IDS = new Set(['desktop']);

/** 距底部该像素内视为「贴底」：恢复步骤流自动跟随 */
const STEP_FOLLOW_RESUME_PX = 24;

/** 撤销令牌/账本过期类错误（agentRuntime UNDO_NOT_FOUND；预留 UNDO_EXPIRED 同义码） */
function isUndoExpiredError(message: string | undefined | null): boolean {
  return typeof message === 'string' && /UNDO_(NOT_FOUND|EXPIRED)/.test(message);
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
  if (
    (modeRaw !== 'frontend' && modeRaw !== 'backend' && modeRaw !== 'suggestion') ||
    typeof candidate.applied !== 'number' ||
    typeof candidate.totalOps !== 'number' ||
    !Array.isArray(candidate.entityIds) ||
    !Array.isArray(candidate.done) ||
    !Array.isArray(candidate.undone)
  ) {
    // ACR 2.0 AgentActReceipt also has status=completed/partial/failed, but is a
    // different contract. Requiring legacy receipt fields avoids a false 0/0 summary.
    return null;
  }

  return {
    status,
    mode: modeRaw,
    applied: candidate.applied,
    totalOps: candidate.totalOps,
    entityIds: asStringArray(candidate.entityIds),
    done: asStringArray(candidate.done),
    undone: asStringArray(candidate.undone),
    userPatch: asString(candidate.userPatch),
    suggestionPending: candidate.suggestionPending === true,
    message: asString(candidate.message),
    resultUnknown:
      candidate.resultUnknown === true || candidate.code === 'RESULT_UNKNOWN',
    code: asString(candidate.code),
    retryable: candidate.retryable === true,
  };
}

function isResultUnknown(toolOutput: unknown, blockError?: string): boolean {
  const outer = asRecord(toolOutput);
  const candidate = asRecord(outer?.result) ?? outer;
  if (
    candidate?.resultUnknown === true
    || candidate?.code === 'RESULT_UNKNOWN'
  ) {
    return true;
  }
  const strings = [blockError, candidate?.error, outer?.error]
    .filter((value): value is string => typeof value === 'string');
  return strings.some((value) => value.includes('RESULT_UNKNOWN'));
}

interface ParsedAgentActResult {
  status: 'completed' | 'partial' | 'failed';
  verified: boolean;
  failedConditionCount: number;
  undoToken?: string;
  undoDurability?: 'persistent' | 'session';
}

function parseAgentActResult(toolOutput: unknown): ParsedAgentActResult | null {
  const outer = asRecord(toolOutput);
  if (!outer) return null;
  const candidate = asRecord(outer.result) ?? outer;
  const status = asString(candidate.status);
  if (status !== 'completed' && status !== 'partial' && status !== 'failed') return null;
  // Distinguish from legacy AcrReceipt by requiring the ACR 2.0 revision/result surface.
  if (
    typeof candidate.beforeRevision !== 'string' ||
    typeof candidate.afterRevision !== 'string' ||
    !Array.isArray(candidate.results)
  ) {
    return null;
  }
  const undoDurability = asString(candidate.undoDurability);
  return {
    status,
    verified: candidate.verified === true,
    failedConditionCount: Array.isArray(candidate.failedConditions)
      ? candidate.failedConditions.length
      : 0,
    undoToken: asString(candidate.undoToken),
    undoDurability:
      undoDurability === 'persistent' || undoDurability === 'session'
        ? undoDurability
        : undefined,
  };
}

function receiptStatusKey(
  receipt: AcrReceipt | null,
  blockStatus: string,
  actResult: ParsedAgentActResult | null,
  resultUnknown = false,
): 'running' | 'success' | 'partial' | 'cancelled' | 'unknown' | 'error' {
  if (blockStatus === 'running' || blockStatus === 'pending') return 'running';
  if (resultUnknown) return 'unknown';
  if (actResult?.status === 'partial') return 'partial';
  if (actResult?.status === 'failed') return 'error';
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

const WorkbenchOpsBlock: React.FC<BlockComponentProps> = React.memo(({ block, store }) => {
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
  const actResult = useMemo(() => parseAgentActResult(block.toolOutput), [block.toolOutput]);
  const resultUnknown = useMemo(
    () => isResultUnknown(block.toolOutput, block.error),
    [block.error, block.toolOutput],
  );
  const restoredFromPersistence = isWorkbenchBlockRestored(block.id);
  const statusKey = receiptStatusKey(receipt, block.status, actResult, resultUnknown);
  const sessionId = store?.getState().sessionId;
  const toolCallId = block.toolCallId;
  const runId = sessionId && toolCallId
    ? makeAcrSessionRunId(sessionId, toolCallId)
    : undefined;

  // presence 联动：同 runId 的窗口光环状态（只读订阅，驱动 data-presence-status）
  const presenceStatus = usePresenceStore((s) => {
    if (!runId) return undefined;
    for (const p of Object.values(s.byWindow)) {
      if (p.runId === runId) return p.status;
    }
    return undefined;
  });

  const ledgerAlive = Boolean(
    !restoredFromPersistence
    && runId
    && sessionId
    && stageManager.hasReversibleRun(runId, sessionId)
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

  // ACR 4.0（A8）：步骤流自动滚底——流式追加时跟随最新一条；
  // 用户上滚即暂停跟随，滚回底部附近恢复；prefers-reduced-motion 时瞬滚。
  const stepsListRef = useRef<HTMLUListElement | null>(null);
  const followStepsRef = useRef(true);
  const programmaticStepScrollRef = useRef(false);

  const handleStepsScroll = useCallback(() => {
    const el = stepsListRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= STEP_FOLLOW_RESUME_PX;
    if (programmaticStepScrollRef.current) {
      // 平滑滚动自身触发的中间态不改判「用户上滚」；到底后解除标记
      if (nearBottom) programmaticStepScrollRef.current = false;
      return;
    }
    followStepsRef.current = nearBottom;
  }, []);

  const stepCount = progressSteps.length;
  useEffect(() => {
    if (stepCount === 0 || !followStepsRef.current) return;
    const el = stepsListRef.current;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || typeof el.scrollTo !== 'function') {
      el.scrollTop = el.scrollHeight;
      return;
    }
    programmaticStepScrollRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [stepCount]);

  const targetSummary = useMemo(() => {
    if (!target.typeId) return null;
    return target.instanceKey
      ? `${target.typeId} · ${target.instanceKey}`
      : target.typeId;
  }, [target]);

  const canOpenTarget = Boolean(
    target.typeId && !VIRTUAL_TARGET_TYPE_IDS.has(target.typeId)
  );
  const undoToken = actResult?.undoToken;
  const persistentUndo = undoToken != null && actResult?.undoDurability === 'persistent';
  const showLegacyUndoChrome =
    receipt?.mode === 'frontend' &&
    !receipt.resultUnknown &&
    (receipt.status === 'completed' || receipt.status === 'partial') &&
    Boolean(runId);
  const showUndoChrome = !resultUnknown && (Boolean(undoToken) || showLegacyUndoChrome);

  /** 持久 token 可跨恢复消费；session token 与旧账本只在当前前端生命周期有效。 */
  const canUndo =
    showUndoChrome &&
    Boolean(runId && sessionId) &&
    (undoState === 'idle' || undoState === 'incomplete') &&
    (undoToken ? persistentUndo || !restoredFromPersistence : !restoredFromPersistence && ledgerAlive);

  const undoExpired = showUndoChrome && (
    undoState === 'expired' ||
    (undoToken
      ? restoredFromPersistence && !persistentUndo
      : restoredFromPersistence ||
        (undoState === 'idle' && !ledgerAlive && hadReversibleEntry.current))
  );

  const undoUnavailable = showUndoChrome && (
    undoState === 'unavailable' ||
    !runId ||
    !sessionId ||
    (!undoToken && undoState === 'idle' && !ledgerAlive && !undoExpired)
  );
  const undoRetryAvailable = undoToken ? !undoExpired : ledgerAlive;

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
    if (!runId || !sessionId) {
      setUndoState('unavailable');
      return;
    }
    if (restoredFromPersistence && !persistentUndo) {
      setUndoState('expired');
      return;
    }
    if (undoState !== 'idle' && undoState !== 'incomplete') return;
    if (undoToken) {
      setUndoState('loading');
      try {
        const undoNonce = nextUiUndoNonce();
        const response = await stageManager.handleBridgeRequest({
          correlationId: `ui-undo-${block.id}-${undoNonce}`,
          command: 'revert_run',
          // 点击专用控件即为用户本次 High 确认；授权只作用于当前请求且不记忆。
          args: { undoToken, approvalRiskCeiling: 'high' },
          timeoutMs: 15_000,
          runId: `${runId}:undo:${undoNonce}`,
          toolCallId,
          sessionId,
        });
        const data = asRecord(response.data);
        if (response.ok && data?.reverted === true) {
          setUndoState('reverted');
        } else if (isUndoExpiredError(response.error)) {
          setUndoState('expired');
        } else {
          setUndoState('incomplete');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setUndoState(isUndoExpiredError(message) ? 'expired' : 'incomplete');
      }
      return;
    }
    if (!stageManager.hasReversibleRun(runId, sessionId)) {
      setUndoState(hadReversibleEntry.current ? 'expired' : 'unavailable');
      return;
    }
    setUndoState('loading');
    try {
      const ok = await stageManager.revertRun(runId, sessionId);
      setUndoState(ok ? 'reverted' : 'incomplete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUndoState(isUndoExpiredError(message) ? 'expired' : 'incomplete');
    }
  };

  const statusBadgeClass = {
    running: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    partial: 'bg-warning/10 text-warning',
    unknown: 'bg-warning/10 text-warning',
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
      data-tool-call-id={toolCallId || undefined}
      data-result-unknown={resultUnknown || undefined}
      data-presence-status={presenceStatus || undefined}
    >
      {/* 标题行 */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-border/30"
        data-testid="workbench-ops-header"
      >
        <div className="flex flex-1 items-center gap-2 min-w-0">
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

        <div className="flex flex-shrink-0 items-center gap-2">
          {canOpenTarget && (
            <NotionButton
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpenTarget}
              className="lg:h-7 gap-1.5 bg-muted/30 px-2 text-xs hover:bg-[var(--interactive-hover)]"
              data-testid="workbench-ops-open"
              aria-label={t('blocks.workbenchOps.openTarget')}
              title={t('blocks.workbenchOps.openTarget')}
            >
              <ArrowSquareOut size={16} />
              <span className="hidden sm:inline">{t('blocks.workbenchOps.openTarget')}</span>
            </NotionButton>
          )}

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
            <ul
              ref={stepsListRef}
              onScroll={handleStepsScroll}
              className="space-y-1 max-h-40 overflow-auto"
              data-testid="workbench-ops-steps-list"
            >
              {progressSteps.map((step, index) => (
                <li
                  key={`${index}-${step.slice(0, 24)}`}
                  className="text-xs text-muted-foreground font-mono leading-relaxed pl-3 border-l border-border/40 break-all"
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
                total: receipt.totalOps
              })}
            </p>
          ) : null}
        </div>
      )}

      {actResult && block.status !== 'running' && block.status !== 'pending' && (
        <div className="px-3 py-2 space-y-1.5" data-testid="workbench-agent-act-receipt">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {actResult.verified ? (
              <Check size={13} className="text-success flex-shrink-0" />
            ) : (
              <WarningCircle size={13} className="text-warning flex-shrink-0" />
            )}
            <span>
              {actResult.verified
                ? t('blocks.workbenchOps.verified')
                : t('blocks.workbenchOps.verificationFailed', {
                    count: actResult.failedConditionCount,
                  })}
            </span>
          </p>
          {undoToken && (
            <p className="text-[11px] text-muted-foreground/75" data-testid="workbench-undo-durability">
              {persistentUndo
                ? t('blocks.workbenchOps.undoPersistent')
                : t('blocks.workbenchOps.undoSession')}
            </p>
          )}
        </div>
      )}

      {resultUnknown && block.status !== 'running' && block.status !== 'pending' && (
        <div
          className="border-t border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
          data-testid="workbench-result-unknown"
          role="alert"
        >
          <p className="flex items-center gap-1.5 font-medium">
            <WarningCircle size={14} className="flex-shrink-0" />
            {t('blocks.workbenchOps.resultUnknownTitle')}
          </p>
          <p className="mt-1 text-warning/90">
            {t('blocks.workbenchOps.resultUnknownHint')}
          </p>
        </div>
      )}

      {/* 错误（无 receipt 时） */}
      {block.status === 'error' && !receipt && !resultUnknown && (
        <div className="px-3 py-2 flex items-center gap-1.5 text-xs text-destructive">
          <WarningCircle size={14} />
          {block.error || t('blocks.mcpTool.unknownError')}
        </div>
      )}

      {/* 撤销栏：打开目标窗已收进标题行，避免为单个按钮占据整行 */}
      {showUndoChrome && (
        <div
          className="flex flex-wrap gap-2 px-3 py-2.5 border-t border-border/50"
          data-testid="workbench-ops-footer-actions"
        >
          <p
            className="flex w-full items-start gap-1.5 text-[11px] text-muted-foreground"
            data-testid="workbench-undo-risk"
          >
            <WarningCircle size={12} className="mt-0.5 flex-shrink-0 text-warning" />
            {t('blocks.workbenchOps.undoHighRisk')}
          </p>
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
                ? t('blocks.workbenchOps.undoExpiredHint')
                : undoUnavailable
                  ? t('blocks.workbenchOps.undoUnavailable')
                  : undoState === 'incomplete'
                    ? undoRetryAvailable
                      ? t('blocks.workbenchOps.undoRetry')
                      : t('blocks.workbenchOps.undoIncompleteExhausted')
                    : undefined
            }
          >
            {undoState === 'reverted' ? (
              <>
                <Check size={12} className="text-success" />
                {t('blocks.workbenchOps.undoApplied')}
              </>
            ) : undoState === 'incomplete' ? (
              undoRetryAvailable ? (
                t('blocks.workbenchOps.undoRetry')
              ) : (
                t('blocks.workbenchOps.undoIncompleteExhausted')
              )
            ) : undoExpired ? (
              t('blocks.workbenchOps.undoExpired')
            ) : undoUnavailable ? (
              t('blocks.workbenchOps.undoUnavailable')
            ) : undoState === 'loading' ? (
              t('blocks.workbenchOps.undoing')
            ) : (
              t('blocks.workbenchOps.undo')
            )}
          </NotionButton>
          {undoToken && undoState !== 'reverted' && (
            <span className="self-center text-[11px] text-muted-foreground/70">
              {persistentUndo
                ? t('blocks.workbenchOps.undoPersistentShort')
                : t('blocks.workbenchOps.undoSessionShort')}
            </span>
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
