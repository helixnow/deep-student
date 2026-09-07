/**
 * 任务完成卡片组件
 *
 * 当 Agent 调用 attempt_completion 工具时显示，展示任务完成结果。
 *
 * 两种形态：
 * - variant="card"：完整卡片（BlockRenderer / mcpTool.tsx 路径使用）
 * - variant="inline"：轻量内联形态（ActivityTimeline 主路径使用，贴合时间线左轨）
 *
 * 设计文档：src/features/chat/docs/29-ChatV2-Agent能力增强改造方案.md 第 5.4 节
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDown,
  CheckCircle,
  CircleHalf,
  Copy,
  Prohibit,
  Question,
  SealCheck,
  Terminal,
  WarningDiamond,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import './CompletionCard.css';

// ============================================================================
// 类型定义
// ============================================================================

/** G07-a 验收终态（与后端 finalizer.rs 的 serde snake_case 一一对应） */
export type FinalizationVerdict =
  | 'verified_complete'
  | 'complete_with_exceptions'
  | 'partial'
  | 'blocked'
  | 'outcome_unknown';

/** 单条验收例外（字段全部防御性可选——后端 message/kind 恒有，path 可缺） */
export interface FinalizationException {
  check?: string;
  kind?: string;
  path?: string;
  message?: string;
}

/** 写入完成块 toolOutput.finalization 的验收报告（前端消费子集） */
export interface FinalizationData {
  verdict: FinalizationVerdict;
  exceptions: FinalizationException[];
}

export interface CompletionData {
  /** 任务完成结果 */
  result: string;
  /** 建议执行的命令（可选） */
  command?: string;
  /** G07-a：TaskFinalizer 验收报告（可选，缺失=旧行为不显示徽章） */
  finalization?: FinalizationData;
}

export interface CompletionCardProps {
  data: CompletionData;
  /** card = 完整卡片（默认）；inline = 时间线内联轻量形态 */
  variant?: 'card' | 'inline';
  className?: string;
}

// ============================================================================
// attempt_completion 工具识别 / 数据提取
// ============================================================================

/**
 * 判断是否为 attempt_completion 工具。
 * 与 mcpTool.tsx 的前缀剥离规则一致：兼容 builtin- / builtin: / mcp_ / mcp.tools. / 点分命名。
 */
export function isAttemptCompletionTool(name: string | undefined): boolean {
  if (!name) return false;
  const stripped = name
    .replace(/^builtin[-:]/, '')
    .replace(/^mcp_/, '')
    .replace(/^mcp\.tools\./, '')
    .replace(/^.*\./, '');
  return stripped === 'attempt_completion';
}

const FINALIZATION_VERDICTS: readonly FinalizationVerdict[] = [
  'verified_complete',
  'complete_with_exceptions',
  'partial',
  'blocked',
  'outcome_unknown',
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 从完成块 toolOutput 中提取 G07-a 验收报告。
 * 后端把 finalization 写在 toolOutput 顶层（与 result/task_completed 同级）；
 * 兜底兼容嵌套在 result 内的形态。verdict 非五值之一时按缺失处理（不显示徽章）。
 */
export function extractFinalization(toolOutput: unknown): FinalizationData | undefined {
  const raw = asRecord(toolOutput);
  if (!raw) return undefined;
  const report = asRecord(raw.finalization) ?? asRecord(asRecord(raw.result)?.finalization);
  if (!report) return undefined;
  const verdict = report.verdict;
  if (typeof verdict !== 'string' || !FINALIZATION_VERDICTS.includes(verdict as FinalizationVerdict)) {
    return undefined;
  }
  const exceptions: FinalizationException[] = [];
  if (Array.isArray(report.exceptions)) {
    for (const item of report.exceptions) {
      const rec = asRecord(item);
      if (!rec) continue;
      exceptions.push({
        check: typeof rec.check === 'string' ? rec.check : undefined,
        kind: typeof rec.kind === 'string' ? rec.kind : undefined,
        path: typeof rec.path === 'string' ? rec.path : undefined,
        message: typeof rec.message === 'string' ? rec.message : undefined,
      });
    }
  }
  return { verdict: verdict as FinalizationVerdict, exceptions };
}

/**
 * 从工具输入/输出中提取完成数据。
 * 后端 emit_end 结构：{ result: { completed, result, command, task_completed }, durationMs }；
 * 提取失败时回退到 toolInput 中的 result / command 字段。
 */
export function extractCompletionData(
  toolInput: Record<string, unknown> | undefined,
  toolOutput: unknown,
): CompletionData {
  let inner: { result?: unknown; command?: unknown } | undefined;
  if (toolOutput && typeof toolOutput === 'object') {
    const raw = toolOutput as Record<string, unknown>;
    inner = raw.result && typeof raw.result === 'object'
      ? raw.result as { result?: unknown; command?: unknown }
      : raw;
  }
  const result =
    (typeof inner?.result === 'string' ? inner.result : '') ||
    (typeof toolInput?.result === 'string' ? toolInput.result : '');
  const command =
    (typeof inner?.command === 'string' && inner.command ? inner.command : undefined) ??
    (typeof toolInput?.command === 'string' && toolInput.command ? toolInput.command : undefined);
  return { result, command, finalization: extractFinalization(toolOutput) };
}

// ============================================================================
// 组件实现
// ============================================================================

const SuggestedCommand: React.FC<{ command: string; compact?: boolean }> = ({ command, compact }) => {
  const { t } = useTranslation('chatV2');

  const handleCopyCommand = useCallback(async () => {
    try {
      await copyTextToClipboard(command);
      showGlobalNotification('success', t('completion.commandCopied'));
    } catch {
      showGlobalNotification('error', t('completion.copyFailed'));
    }
  }, [command, t]);

  return (
    <div className={cn('rounded-md bg-muted', compact ? 'p-2' : 'p-3')}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Terminal size={14} />
          {t('completion.suggestedCommand')}
        </span>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={handleCopyCommand}
          className="h-6 px-2 text-xs [@media(pointer:coarse)]:!min-h-11"
        >
          <Copy size={12} className="mr-1" />
          {t('completion.copy')}
        </DsButton>
      </div>
      <CustomScrollArea orientation="horizontal" fullHeight={false} className="rounded bg-background">
        <code className="block px-2 py-1.5 font-mono text-sm">{command}</code>
      </CustomScrollArea>
    </div>
  );
};

// ============================================================================
// G07-a：TaskFinalizer 验收徽章
// ============================================================================

/**
 * 文案走 chatV2:completion.finalization.*，一律带 defaultValue 中文兜底——
 * locale 键由文案线另行补齐，此组件不依赖其落地时序。
 */
const VERDICT_META: Record<
  FinalizationVerdict,
  { icon: React.ComponentType<{ size?: number; weight?: string }>; badgeClass: string; labelKey: string; labelDefault: string }
> = {
  verified_complete: {
    icon: SealCheck as React.ComponentType<{ size?: number; weight?: string }>,
    badgeClass: 'border-success/40 bg-success/10 text-success',
    labelKey: 'completion.finalization.verifiedComplete',
    labelDefault: '已验收',
  },
  complete_with_exceptions: {
    icon: WarningDiamond as React.ComponentType<{ size?: number; weight?: string }>,
    badgeClass: 'border-warning/40 bg-warning/10 text-warning',
    labelKey: 'completion.finalization.completeWithExceptions',
    labelDefault: '完成（有例外）',
  },
  partial: {
    icon: CircleHalf as React.ComponentType<{ size?: number; weight?: string }>,
    // 橙色无私有语义 token，走 CompletionCard.css 的 --completion-partial（随暗色翻转）
    badgeClass:
      'border-[hsl(var(--completion-partial)/0.4)] bg-[hsl(var(--completion-partial)/0.1)] text-[hsl(var(--completion-partial))]',
    labelKey: 'completion.finalization.partial',
    labelDefault: '部分完成',
  },
  blocked: {
    icon: Prohibit as React.ComponentType<{ size?: number; weight?: string }>,
    badgeClass: 'border-danger/40 bg-danger/10 text-danger',
    labelKey: 'completion.finalization.blocked',
    labelDefault: '受阻',
  },
  outcome_unknown: {
    icon: Question as React.ComponentType<{ size?: number; weight?: string }>,
    badgeClass: 'border-border bg-muted text-muted-foreground',
    labelKey: 'completion.finalization.outcomeUnknown',
    labelDefault: '结果未知',
  },
};

const EXCEPTION_KIND_TEXT: Record<string, { labelKey: string; labelDefault: string }> = {
  artifact_missing: {
    labelKey: 'completion.finalization.kind.artifactMissing',
    labelDefault: '产物缺失',
  },
  hash_mismatch: {
    labelKey: 'completion.finalization.kind.hashMismatch',
    labelDefault: '哈希不符',
  },
  invalid_declaration: {
    labelKey: 'completion.finalization.kind.invalidDeclaration',
    labelDefault: '申报非法',
  },
  check_unavailable: {
    labelKey: 'completion.finalization.kind.checkUnavailable',
    labelDefault: '检查不可用',
  },
};

const FinalizationBadge: React.FC<{ finalization: FinalizationData; className?: string }> = ({
  finalization,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [expanded, setExpanded] = useState(false);
  const meta = VERDICT_META[finalization.verdict];
  const Icon = meta.icon;
  const { exceptions } = finalization;

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="completion-finalization-badge"
          data-verdict={finalization.verdict}
          className={cn(
            'inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-xs font-medium',
            meta.badgeClass,
          )}
        >
          <Icon size={12} weight="fill" />
          {t(meta.labelKey, { defaultValue: meta.labelDefault })}
        </span>
        {exceptions.length > 0 && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11"
          >
            {t('completion.finalization.exceptionsToggle', {
              defaultValue: '例外项（{{count}}）',
              count: exceptions.length,
            })}
            <CaretDown size={12} className={cn('transition-transform', expanded && 'rotate-180')} />
          </button>
        )}
      </div>
      {expanded && exceptions.length > 0 && (
        <ul
          data-testid="completion-finalization-exceptions"
          className="space-y-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-xs"
        >
          {exceptions.map((ex, index) => {
            const kindMeta = ex.kind ? EXCEPTION_KIND_TEXT[ex.kind] : undefined;
            return (
              <li key={index} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-foreground">
                    {kindMeta
                      ? t(kindMeta.labelKey, { defaultValue: kindMeta.labelDefault })
                      : ex.kind}
                  </span>
                  {ex.path && (
                    <code className="rounded bg-background px-1 py-0.5 font-mono text-2xs break-all">
                      {ex.path}
                    </code>
                  )}
                </span>
                {ex.message && (
                  <span className="break-words text-muted-foreground">{ex.message}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export const CompletionCard: React.FC<CompletionCardProps> = ({ data, variant = 'card', className }) => {
  const { t } = useTranslation('chatV2');

  if (variant === 'inline') {
    // 时间线内联形态：无厚边框卡片，贴合左轨节奏；颜色走语义 token
    return (
      <div
        className={cn(
          'rounded-[var(--chat-radius-md,12px)] border border-success/30 bg-success/5 px-3 py-2 space-y-2',
          className,
        )}
      >
        <div className="flex items-center gap-1.5 text-sm font-medium text-success">
          <CheckCircle size={16} weight="fill" />
          {t('completion.title')}
        </div>
        {/* G07-a：验收徽章与模型自述 result 并列展示，不替代 */}
        {data.finalization && <FinalizationBadge finalization={data.finalization} />}
        {data.result && (
          <div className="whitespace-pre-wrap break-words text-sm text-foreground">
            {data.result}
          </div>
        )}
        {data.command && <SuggestedCommand command={data.command} compact />}
      </div>
    );
  }

  return (
    <Card
      className={cn(
        'border border-success/40 bg-success/5',
        className
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base text-success">
          <CheckCircle size={20} weight="fill" />
          {t('completion.title')}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* G07-a：验收徽章与模型自述 result 并列展示，不替代 */}
        {data.finalization && <FinalizationBadge finalization={data.finalization} />}

        {/* 结果文本 */}
        <div className="text-sm text-foreground whitespace-pre-wrap break-words">{data.result}</div>

        {/* 建议命令（如果有） */}
        {data.command && <SuggestedCommand command={data.command} />}
      </CardContent>
    </Card>
  );
};

export default CompletionCard;
