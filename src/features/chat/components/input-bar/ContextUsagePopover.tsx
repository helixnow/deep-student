/**
 * 上下文用量明细弹层（Cursor context ring 式交互）。
 *
 * 点击输入栏的上下文水位环弹出：
 * - 上下文窗口占用：used / limit tokens、百分比、剩余量
 * - 会话累计：总 tokens、费用（useSessionUsageSummary 已有数据）
 * - 压缩状态：active compaction 的压缩前后 token（来自 compaction_summary 块元数据）
 * - "压缩上下文"快捷操作（复用 ComposerPlusMenu 的手动压缩逻辑，流式中禁用）
 *
 * 全部使用现有可得数据，不新增后端接口。定位/视口防溢出由 AppMenu 提供
 * （移动端小屏自动 clamp 到视口内）。
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, CircleNotch } from '@phosphor-icons/react';
import { AppMenu, AppMenuContent, AppMenuTrigger } from '@/components/ui/app-menu/AppMenu';
import { DsButton } from '@/components/ui/DsButton';
import { Z_INDEX } from '@/config/zIndex';
import type { SessionUsageSummary } from '@/api/llmUsageApi';
import type { ContextWindowUsage } from './contextWindowUsage';
import { formatContextTokenAmount } from './contextWindowUsage';
import type { ContextCompactionInfo } from './contextCompactionInfo';

export interface ContextUsagePopoverProps {
  usage: ContextWindowUsage;
  sessionUsage?: SessionUsageSummary | null;
  /** 手动压缩（复用 ComposerPlusMenu 的调用逻辑） */
  onCompactContext?: () => void | Promise<void>;
  isCompactingContext?: boolean;
  /** 流式中禁用压缩（与加号菜单的现有约束一致） */
  compactDisabled?: boolean;
  /** 懒读 active compaction 元数据（弹层打开时才调用） */
  getCompactionInfo?: () => ContextCompactionInfo | null;
  /** 触发器（上下文水位环） */
  children: React.ReactNode;
}

function UsageRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[color:var(--text-secondary)]">{label}</span>
      <span className="font-mono tabular-nums text-[color:var(--text-primary)]">{value}</span>
    </div>
  );
}

export const ContextUsagePopover: React.FC<ContextUsagePopoverProps> = ({
  usage,
  sessionUsage,
  onCompactContext,
  isCompactingContext = false,
  compactDisabled = false,
  getCompactionInfo,
  children,
}) => {
  const { t } = useTranslation(['chatV2']);
  const [open, setOpen] = useState(false);
  const [compactionInfo, setCompactionInfo] = useState<ContextCompactionInfo | null>(null);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        // compaction 元数据只在打开瞬间读取一次（懒读 store，避免流式期间反复扫描）
        setCompactionInfo(getCompactionInfo?.() ?? null);
      }
    },
    [getCompactionInfo],
  );

  const handleCompact = useCallback(() => {
    if (!onCompactContext || compactDisabled || isCompactingContext) return;
    void onCompactContext();
  }, [compactDisabled, isCompactingContext, onCompactContext]);

  const usageColor =
    usage.usedPercent >= 90
      ? 'hsl(var(--danger))'
      : usage.usedPercent >= 75
        ? 'hsl(var(--warning))'
        : 'var(--text-primary)';

  const showCompaction = compactionInfo?.isActive === true;

  return (
    <AppMenu open={open} onOpenChange={handleOpenChange}>
      <AppMenuTrigger asChild>
        <span
          className="inline-flex cursor-pointer rounded-md"
          data-testid="context-usage-popover-trigger"
        >
          {children}
        </span>
      </AppMenuTrigger>
      <AppMenuContent
        align="end"
        width="min(300px, calc(100vw - 16px))"
        style={{ zIndex: Z_INDEX.composerPanel }}
        data-testid="context-usage-popover"
      >
        <div className="px-3 py-2.5 text-xs">
          {/* 上下文窗口占用 */}
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold text-[color:var(--text-primary)]">
              {t('chatV2:tokenUsage.contextWindow')}
            </span>
            <span className="rounded-full border border-[color:var(--input-shell-border)] bg-[color:var(--surface-panel-muted)] px-1.5 py-0.5 font-mono text-2xs leading-none tabular-nums text-[color:var(--text-secondary)]">
              {usage.usedPercent}%
            </span>
          </div>
          <div className="mb-2.5 mt-2 h-1.5 overflow-hidden rounded-full bg-[color:var(--button-utility-hover)] ring-1 ring-[color:var(--input-shell-border)]">
            <div
              className="h-full rounded-full transition-[width] duration-150"
              style={{ width: `${usage.usedPercent}%`, background: usageColor }}
            />
          </div>
          <div className="space-y-1.5">
            <UsageRow
              label={t('chatV2:tokenUsage.contextUsedPercent', { percent: usage.usedPercent })}
              value={t('chatV2:tokenUsage.contextUsedTokens', { tokens: usage.usedLabel })}
            />
            <UsageRow
              label={t('chatV2:tokenUsage.contextRemainingPercent', { percent: usage.remainingPercent })}
              value={t('chatV2:tokenUsage.contextRemainingTokens', { tokens: usage.remainingLabel })}
            />
            <UsageRow
              label={t('chatV2:contextUsagePopover.limit')}
              value={t('chatV2:tokenUsage.tokensValue', {
                count: formatContextTokenAmount(usage.limitTokens),
              })}
            />
          </div>
          {usage.usedPercent >= 75 && (
            <p className="mt-2 border-t border-[color:var(--input-shell-border)] pt-2 text-[11px] leading-snug text-[color:var(--text-secondary)]">
              {t('chatV2:tokenUsage.contextHighWaterHint')}
            </p>
          )}

          {/* 会话累计（token / 费用） */}
          {sessionUsage && sessionUsage.totalTokens > 0 && (
            <div className="mt-2 space-y-1.5 border-t border-[color:var(--input-shell-border)] pt-2">
              <UsageRow
                label={t('chatV2:tokenUsage.sessionTotal')}
                value={formatContextTokenAmount(sessionUsage.totalTokens)}
              />
              {typeof sessionUsage.estimatedCostUsd === 'number' && sessionUsage.estimatedCostUsd > 0 && (
                <UsageRow
                  label={t('chatV2:tokenUsage.sessionCost')}
                  value={`$${sessionUsage.estimatedCostUsd.toFixed(sessionUsage.estimatedCostUsd < 0.1 ? 4 : 2)}`}
                />
              )}
            </div>
          )}

          {/* 压缩状态（仅 active compaction 存在时展示） */}
          {showCompaction && (
            <div className="mt-2 space-y-1.5 border-t border-[color:var(--input-shell-border)] pt-2">
              <UsageRow
                label={t('chatV2:contextUsagePopover.compactionStatus')}
                value={t('chatV2:contextUsagePopover.compactionActive')}
              />
              {compactionInfo?.tokensBefore !== undefined && compactionInfo?.tokensAfter !== undefined && (
                <UsageRow
                  label={t('chatV2:contextUsagePopover.compactionTokens')}
                  value={`${formatContextTokenAmount(compactionInfo.tokensBefore)} → ${formatContextTokenAmount(compactionInfo.tokensAfter)}`}
                />
              )}
            </div>
          )}

          {/* 快捷操作：压缩上下文 */}
          {onCompactContext && (
            <div className="mt-2.5 border-t border-[color:var(--input-shell-border)] pt-2.5">
              <DsButton
                variant="secondary"
                size="sm"
                className="w-full justify-center gap-1.5"
                onClick={handleCompact}
                disabled={compactDisabled || isCompactingContext}
                title={
                  compactDisabled
                    ? t('chatV2:contextUsagePopover.compactDisabledStreaming')
                    : undefined
                }
                data-testid="context-usage-compact-action"
              >
                {isCompactingContext ? (
                  <CircleNotch className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Archive className="h-3.5 w-3.5" />
                )}
                <span>
                  {isCompactingContext
                    ? t('chatV2:inputBar.plusMenu.compactingContext')
                    : t('chatV2:inputBar.plusMenu.compactContext')}
                </span>
              </DsButton>
            </div>
          )}
        </div>
      </AppMenuContent>
    </AppMenu>
  );
};
