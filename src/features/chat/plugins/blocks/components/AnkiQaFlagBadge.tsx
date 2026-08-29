/**
 * ChatAnki 卡片质检标记展示组件
 *
 * - AnkiQaFlagBadge：单卡徽标（图标 + 文字计数 + 严重度文本），点击展开详情列表。
 *   无障碍：严重度同时用图标形状 + 文本传达（不只靠颜色）；
 *   徽标是 button（aria-expanded/aria-controls），详情列表是语义化 ul。
 * - AnkiQaFlagsSummaryChip：块级摘要条（N 张卡片带质检标记 + 复查提示）。
 *
 * `_qa_flags` 只在这里以结构化方式展示，绝不拼进 front/back 文本。
 * lint 条目按稳定 code 走 i18n（qaFlags.lint.<code>），后端中文 message
 * 仅作诊断与回退，不再直接进入非中文界面。
 */

import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, Info, Warning, WarningOctagon } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import {
  CRITIC_QA_FLAG_CODES,
  maxFlagSeverity,
  type QaFlagEntry,
  type QaFlagSeverity,
} from './ankiQaFlags';
import './chat-anki-cards.css';

const SEVERITY_LABEL_KEYS: Record<QaFlagSeverity, string> = {
  info: 'qaFlags.severity.info',
  warn: 'qaFlags.severity.warn',
  error: 'qaFlags.severity.error',
};

/** 旧字段规则条目（rule 名）已有 i18n；lint 条目按稳定 code 查 qaFlags.lint.*。 */
const LEGACY_RULE_LABEL_KEYS: Record<string, string> = {
  minLength: 'qaFlags.rules.minLength',
  maxLength: 'qaFlags.rules.maxLength',
  allowedValues: 'qaFlags.rules.allowedValues',
  validationPattern: 'qaFlags.rules.validationPattern',
};

/**
 * 稳定 lint code → 本地化词条（qaFlags.lint.<code>）。
 * 与后端 `anki_qa_lint.rs` 的 `codes::ALL` 对齐；`legacy_flags_unparsed`
 * 故意不在此列——它的 message 就是待展示的原始历史标记内容。
 * 未收录的（未来新增）code 自动回退展示后端 message。
 */
const LINT_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  [
    'front_back_identical',
    'empty_front',
    'empty_back',
    'cloze_unclosed',
    'cloze_empty_answer',
    'cloze_bad_index',
    'cloze_missing',
    'answer_leak',
    'multi_concept',
    'front_too_long',
    'placeholder_residue',
    'todo_residue',
    'xxx_residue',
    'empty_brackets',
    'tags_empty',
    'duplicate_in_document',
    'near_duplicate',
    'mixed_language',
    'mcq_too_few_options',
    'mcq_answer_not_in_options',
    'mcq_missing_answer',
    'field_rule_min_length',
    'field_rule_max_length',
    'field_rule_allowed_values',
    'field_rule_pattern',
  ].map((code) => [code, `qaFlags.lint.${code}`]),
);

/**
 * 需要插值数字参数的 lint code → 参数名列表。
 * 后端 message 是中文诊断文本，其中的数字（计数/阈值/百分比）是唯一
 * 语言无关的部分：按出现顺序抽取并映射到这里声明的参数名。
 * 顺序契约见 `anki_qa_lint.rs` 中 `LintIssue::message` 的文档注释。
 */
const LINT_NUMERIC_PARAM_NAMES: Record<string, readonly string[]> = {
  cloze_unclosed: ['n'],
  cloze_empty_answer: ['n'],
  cloze_bad_index: ['n'],
  front_too_long: ['n', 'limit'],
  near_duplicate: ['percent'],
  mixed_language: ['cjk', 'latin'],
  mcq_too_few_options: ['n'],
  field_rule_min_length: ['n', 'min'],
  field_rule_max_length: ['n', 'max'],
};

/**
 * 从后端 message 中按出现顺序抽取该 code 声明的数字参数。
 * message 中数字不足（异常数据/未来文案变化）时返回 null，
 * 调用方回退展示原始 message，避免渲染出带空洞的模板。
 */
function resolveLintNumericParams(
  code: string,
  message: string,
): Record<string, string> | null {
  const names = LINT_NUMERIC_PARAM_NAMES[code];
  if (!names) return {};
  const numbers = message.match(/\d+(?:\.\d+)?/g) ?? [];
  if (numbers.length < names.length) return null;
  const params: Record<string, string> = {};
  names.forEach((name, index) => {
    params[name] = numbers[index];
  });
  return params;
}

/** critic 后端 message 当前为中文；按稳定 code 解析，避免英文界面泄漏未本地化文案。 */
const CRITIC_FLAG_LABEL_KEYS: Record<string, string> = {
  [CRITIC_QA_FLAG_CODES.flagged]: 'agent.critic.flaggedFlag',
  [CRITIC_QA_FLAG_CODES.revised]: 'agent.critic.revisedFlag',
};

const SeverityIcon: React.FC<{ severity: QaFlagSeverity; size?: number; className?: string }> = ({
  severity,
  size = 12,
  className,
}) => {
  // 形状区分严重度（无障碍：不只靠颜色）：圆形 info / 三角 warn / 八角 error
  if (severity === 'error') {
    return <WarningOctagon size={size} weight="fill" className={className} aria-hidden="true" />;
  }
  if (severity === 'warn') {
    return <Warning size={size} weight="fill" className={className} aria-hidden="true" />;
  }
  return <Info size={size} weight="fill" className={className} aria-hidden="true" />;
};

function severityToneClass(severity: QaFlagSeverity | null): string {
  if (severity === 'error') return 'border-destructive/40 bg-destructive/10 text-destructive';
  if (severity === 'warn') return 'border-warning/40 bg-warning/10 text-warning';
  return 'border-border bg-muted/40 text-muted-foreground';
}

export const AnkiQaFlagBadge: React.FC<{
  flags: QaFlagEntry[];
  cardIndex: number;
  className?: string;
}> = ({ flags, cardIndex, className }) => {
  const { t } = useTranslation('anki');
  const [expanded, setExpanded] = useState(false);
  // cardIndex 只在单个块内唯一；useId 避免同屏多个 anki_cards 块产生重复 aria-controls。
  const detailsId = `chatanki-qa-flags-details-${useId().replace(/:/g, '')}`;
  const severity = useMemo(() => maxFlagSeverity(flags), [flags]);

  if (flags.length === 0) return null;

  const severityLabel = severity ? t(SEVERITY_LABEL_KEYS[severity]) : '';

  const resolveFlagMessage = (flag: QaFlagEntry): string => {
    const criticKey = CRITIC_FLAG_LABEL_KEYS[flag.code];
    if (criticKey) return t(criticKey);
    // lint 条目：优先按稳定 code 查本地化词条（后端 message 是中文诊断文本，
    // 直接展示会泄漏进英文界面），数字参数从 message 中抽取插值。
    const lintKey = LINT_LABEL_KEYS[flag.code];
    if (lintKey) {
      const params = resolveLintNumericParams(flag.code, flag.message);
      if (params) return t(lintKey, params);
    }
    if (flag.message) return flag.message;
    const legacyKey = LEGACY_RULE_LABEL_KEYS[flag.code];
    if (legacyKey) return t(legacyKey);
    return flag.code;
  };

  return (
    <div className={cn('min-w-0', className)}>
      <DsButton
        type="button"
        variant="ghost"
        size="sm"
        data-testid="chatanki-qa-flag-badge"
        data-severity={severity ?? 'info'}
        onClick={(event) => {
          // 卡片本体点击是翻面/进入编辑，徽标点击只切换详情
          event.stopPropagation();
          setExpanded((prev) => !prev);
        }}
        onKeyDown={(event) => event.stopPropagation()}
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={t('qaFlags.cardFlagsAria', {
          index: cardIndex + 1,
          count: flags.length,
          severity: severityLabel,
        })}
        title={t(expanded ? 'qaFlags.hideDetails' : 'qaFlags.showDetails')}
        className={cn(
          '!h-auto min-h-0 max-w-full gap-1 rounded-full border !px-2 !py-0.5 text-xs font-normal leading-none',
          'transition-colors hover:opacity-80',
          severityToneClass(severity),
        )}
      >
        <SeverityIcon severity={severity ?? 'info'} />
        <span className="truncate">
          {t('qaFlags.cardBadge', { count: flags.length })}
          {severityLabel ? ` · ${severityLabel}` : ''}
        </span>
        <CaretDown
          size={10}
          className={cn('flex-shrink-0 transition-transform duration-150', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </DsButton>
      {expanded && (
        <ul
          id={detailsId}
          data-testid="chatanki-qa-flag-details"
          className="mt-1 space-y-0.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground"
        >
          {flags.map((flag, idx) => (
            <li key={`${flag.code}-${flag.field}-${idx}`} className="flex items-start gap-1.5 leading-snug">
              <SeverityIcon
                severity={flag.severity}
                className={cn(
                  'mt-0.5 flex-shrink-0',
                  flag.severity === 'error' && 'text-destructive',
                  flag.severity === 'warn' && 'text-warning',
                )}
              />
              <span className="min-w-0">
                <span className="font-medium">{t(SEVERITY_LABEL_KEYS[flag.severity])}</span>
                {flag.field ? (
                  <span>
                    {' · '}
                    {t('qaFlags.fieldLabel')}: {flag.field}
                  </span>
                ) : null}
                {' · '}
                {resolveFlagMessage(flag)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const AnkiQaFlagsSummaryChip: React.FC<{
  flaggedCardCount: number;
  maxSeverity: QaFlagSeverity | null;
  className?: string;
}> = ({ flaggedCardCount, maxSeverity, className }) => {
  const { t } = useTranslation('anki');
  if (flaggedCardCount <= 0) return null;
  return (
    <div
      role="note"
      data-testid="chatanki-qa-flags-summary"
      className={cn(
        'ui-rise-in mt-2 flex flex-wrap items-start gap-1.5 rounded-lg border px-3 py-1.5 text-xs leading-snug',
        severityToneClass(maxSeverity),
        className,
      )}
    >
      <SeverityIcon severity={maxSeverity ?? 'warn'} size={14} className="mt-0.5 flex-shrink-0" />
      <span className="min-w-0">
        <span className="font-medium">
          {t('qaFlags.flaggedCards', { count: flaggedCardCount })}
        </span>
        {' · '}
        <span className="opacity-90">{t('qaFlags.hint')}</span>
      </span>
    </div>
  );
};
