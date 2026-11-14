/**
 * Chat V2 - 用户提问块组件
 *
 * 在工具调用时间线中渲染一个交互式提问卡片，支持：
 * - 单选模式：按钮点击即提交
 * - 多选模式：复选框 + 确认按钮
 * - 可配置的自定义输入框
 * - 已回答状态的只读视图
 *
 * 设计参考：
 * - ToolApprovalCard.tsx（倒计时 + invoke 交互模式）
 * - sleepBlock.tsx（独立块类型注册模式）
 */

import { stripRecommendedMarker } from '@/features/chat/utils/askUserLabel';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  ChatCircleDots,
  Check,
  Info,
  Star,
  PaperPlaneRight,
  WarningCircle,
} from '@phosphor-icons/react';

import type { BlockComponentProps } from '../../registry/blockRegistry';
import { blockRegistry } from '../../registry/blockRegistry';
import { cn } from '@/utils/cn';
import { TextShimmer } from '../../components/ui/TextShimmer';
import { ToolActivitySweep } from '../../components/ui/ToolActivitySweep';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { InteractiveHtmlCanvas } from '@/components/previews/InteractiveHtmlCanvas';
import { OpenUILangRenderer } from '@/features/generative-ui';

// ============================================================================
// 类型定义
// ============================================================================

/** 可视化提问附带的受限 HTML 演示载荷 */
export interface AskUserPresentation {
  html: string;
  title?: string;
}

/** 多题模式下的单题结构 */
export interface AskUserQuestionItem {
  id?: string;
  header?: string;
  question: string;
  options?: Array<string | { id?: string; label?: string; value?: string; text?: string; reason?: string }>;
  multiple?: boolean;
  allowCustom?: boolean;
  context?: string;
  presentation?: AskUserPresentation | null;
}

/** 提问块输入数据（LLM 工具调用参数） */
export interface AskUserBlockInput {
  question?: string;
  options?: Array<string | { id?: string; label?: string; value?: string; text?: string; reason?: string }>;
  multiple?: boolean; // default false
  allowCustom?: boolean; // default true
  timeoutSeconds?: number; // optional, no timeout if not set
  context?: string;
  html?: string;
  ui?: string;
  title?: string;
  presentation?: AskUserPresentation | null;
  questions?: AskUserQuestionItem[];
}

interface AskUserOptionViewModel {
  id?: string;
  label: string;
  reason?: string;
}

const DANGEROUS_PRESENTATION_HTML_RE =
  /<\s*(?:iframe|object|embed|base)\b|<\s*meta\b[^>]*\bhttp-equiv\b/i;

/**
 * 校验 presentation.html 是否非空且不含危险嵌套/重定向标签
 * （<iframe、<object、<embed、<meta http-equiv、<base）。
 */
export function isValidPresentationHtml(html: unknown): html is string {
  if (typeof html !== 'string') return false;
  const trimmed = html.trim();
  if (trimmed.length === 0) return false;
  if (DANGEROUS_PRESENTATION_HTML_RE.test(trimmed)) return false;
  return true;
}

function normalizeAskUserOptions(
  rawOptions: AskUserBlockInput['options'] | string
): AskUserOptionViewModel[] {
  const candidateOptions = Array.isArray(rawOptions)
    ? rawOptions
    : typeof rawOptions === 'string'
      ? [rawOptions]
      : [];

  return candidateOptions
    .map((option) => {
      if (typeof option === 'string') {
        return { label: option };
      }

      if (option && typeof option === 'object') {
        const label =
          typeof option.label === 'string'
            ? option.label
            : typeof option.value === 'string'
              ? option.value
              : typeof option.text === 'string'
                ? option.text
                : null;

        if (label) {
          return {
            id: typeof option.id === 'string' ? option.id : undefined,
            label,
            reason: typeof option.reason === 'string' ? option.reason : undefined,
          };
        }

        try {
          return { label: JSON.stringify(option) };
        } catch {
          return { label: String(option) };
        }
      }

      return { label: String(option ?? '') };
    })
    .map((option) => ({ ...option, label: stripRecommendedMarker(option.label) }))
    .filter((option) => option.label.length > 0);
}

interface SandboxCandidateAnswer {
  selectedTexts: string[];
  selectedIndices: number[];
  customText: string | null;
  source: string;
  displaySummary: string;
}

function parseSandboxCandidateAnswer(
  rawPayload: unknown,
  options: AskUserOptionViewModel[],
  fallbackSummary?: string
): SandboxCandidateAnswer {
  const matchedIndexSet = new Set<number>();
  const customParts: string[] = [];

  const matchOptionToken = (token: unknown): boolean => {
    if (typeof token === 'number' && Number.isInteger(token) && token >= 0 && token < options.length) {
      matchedIndexSet.add(token);
      return true;
    }
    if (typeof token === 'string') {
      const normalized = stripRecommendedMarker(token.trim());
      if (!normalized) return false;
      const byIndex = options.findIndex(
        (opt, idx) =>
          opt.label === normalized ||
          opt.id === normalized ||
          String(idx) === normalized
      );
      if (byIndex >= 0) {
        matchedIndexSet.add(byIndex);
        return true;
      }
    }
    return false;
  };

  const inspectValue = (val: unknown) => {
    if (val === null || val === undefined) return;
    if (typeof val === 'number') {
      matchOptionToken(val);
      return;
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed) return;
      if (!matchOptionToken(trimmed)) {
        customParts.push(trimmed);
      }
      return;
    }
    if (Array.isArray(val)) {
      val.forEach((item) => {
        if (!matchOptionToken(item) && typeof item === 'string' && item.trim()) {
          customParts.push(item.trim());
        }
      });
      return;
    }
    if (typeof val === 'object') {
      const record = val as Record<string, unknown>;
      const indicesOrIds =
        record.selectedIndices ??
        record.selected_indices ??
        record.selectedIds ??
        record.selected_ids ??
        record.selected ??
        record.options;

      if (Array.isArray(indicesOrIds)) {
        indicesOrIds.forEach((item) => {
          if (!matchOptionToken(item) && typeof item === 'string' && item.trim()) {
            customParts.push(item.trim());
          }
        });
      } else if (indicesOrIds !== undefined) {
        inspectValue(indicesOrIds);
      }

      const textCandidate =
        typeof record.customText === 'string'
          ? record.customText
          : typeof record.custom_text === 'string'
            ? record.custom_text
            : typeof record.text === 'string'
              ? record.text
              : typeof record.note === 'string'
                ? record.note
                : typeof record.value === 'string'
                  ? record.value
                  : typeof record.label === 'string'
                    ? record.label
                    : null;

      if (textCandidate && textCandidate.trim()) {
        if (!matchOptionToken(textCandidate.trim())) {
          customParts.push(textCandidate.trim());
        }
      } else if (record.answer !== undefined) {
        inspectValue(record.answer);
      } else if (record.data !== undefined) {
        inspectValue(record.data);
      } else if (matchedIndexSet.size === 0 && customParts.length === 0) {
        try {
          customParts.push(JSON.stringify(record));
        } catch {
          customParts.push(String(record));
        }
      }
    }
  };

  inspectValue(rawPayload);

  if (
    matchedIndexSet.size === 0 &&
    customParts.length === 0 &&
    typeof fallbackSummary === 'string' &&
    fallbackSummary.trim()
  ) {
    inspectValue(fallbackSummary.trim());
  }

  const selectedIndices = Array.from(matchedIndexSet).sort((a, b) => a - b);
  const selectedTexts = selectedIndices
    .map((idx) => options[idx]?.label)
    .filter((label): label is string => Boolean(label));
  const customText = customParts.length > 0 ? Array.from(new Set(customParts)).join(' · ') : null;

  let source = 'user_click';
  if (selectedTexts.length > 0 && customText) {
    source = 'mixed';
  } else if (customText) {
    source = 'custom_input';
  }

  const summarySegments: string[] = [];
  if (selectedTexts.length > 0) {
    summarySegments.push(selectedTexts.join('、'));
  }
  if (customText) {
    summarySegments.push(customText);
  }
  if (summarySegments.length === 0 && typeof fallbackSummary === 'string' && fallbackSummary.trim()) {
    summarySegments.push(fallbackSummary.trim());
  }

  return {
    selectedTexts,
    selectedIndices,
    customText,
    source,
    displaySummary: summarySegments.join(' · ') || '未填写内容',
  };
}

/** 提问块输出数据（用户回答结果） */
interface AskUserBlockOutput {
  question: string;
  selected: string[]; // array (even for single-select, length 1)
  selected_indices: number[];
  custom_text: string | null;
  source: string; // "user_click" | "custom_input" | "mixed" | "timeout" | "channel_closed"
  options: string[];
  multiple: boolean;
  html?: string;
  ui?: string;
  title?: string;
}

/** 从 toolOutput 中解包 result（后端发送 { result: actualOutput, durationMs }） */
function unwrapOutput(toolOutput: unknown): AskUserBlockOutput | undefined {
  if (!toolOutput || typeof toolOutput !== 'object') return undefined;
  const obj = toolOutput as Record<string, unknown>;
  // 后端发送格式: { result: { question, selected, ... }, durationMs: N }
  if (obj.result && typeof obj.result === 'object') {
    return obj.result as AskUserBlockOutput;
  }
  // DB 恢复格式: 直接是 { question, selected, ... }
  if ('question' in obj && 'selected' in obj) {
    return obj as unknown as AskUserBlockOutput;
  }
  return undefined;
}

// ============================================================================
// 共享子组件（统一头部、错误条与已回答摘要）
// ============================================================================

interface AskUserHeaderProps {
  title: string;
  answered?: boolean;
  isPreparing?: boolean;
  hasBorder?: boolean;
}

const AskUserHeader: React.FC<AskUserHeaderProps> = ({
  title,
  answered = false,
  isPreparing = false,
  hasBorder = true,
}) => (
  <div
    className={cn(
      'flex items-center gap-2 px-3 py-2.5',
      hasBorder && 'border-b border-border/30'
    )}
  >
    <ToolActivitySweep
      active={isPreparing}
      className={cn(
        'h-7 w-7 shrink-0 justify-center rounded-md',
        answered
          ? 'bg-success/10 text-success'
          : 'bg-muted/70 dark:bg-muted/40 text-muted-foreground'
      )}
    >
      {answered ? <Check size={16} /> : <ChatCircleDots size={16} />}
    </ToolActivitySweep>
    {isPreparing ? (
      <TextShimmer
        className="text-xs font-medium leading-4 text-muted-foreground"
        duration={1.5}
        spread={3}
      >
        {title}
      </TextShimmer>
    ) : (
      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
        {title}
      </span>
    )}
  </div>
);

interface AskUserSubmitErrorBannerProps {
  error: string;
  title: string;
  retryHint: string;
}

const AskUserSubmitErrorBanner: React.FC<AskUserSubmitErrorBannerProps> = ({
  error,
  title,
  retryHint,
}) => (
  <div className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
    <WarningCircle size={14} className="mt-0.5 flex-shrink-0 text-destructive" />
    <div className="min-w-0 flex-1 text-xs">
      <span className="font-medium text-destructive">{title}</span>
      {error && (
        <span className="ml-1 break-words text-destructive/80">{error}</span>
      )}
      <div className="mt-0.5 text-muted-foreground">{retryHint}</div>
    </div>
  </div>
);

interface AskUserAnswerSummaryProps {
  label: string;
  value: string;
  sourceLabel?: string;
  showCheckIcon?: boolean;
  borderedFooter?: boolean;
  testId?: string;
}

const AskUserAnswerSummary: React.FC<AskUserAnswerSummaryProps> = ({
  label,
  value,
  sourceLabel,
  showCheckIcon = false,
  borderedFooter = false,
  testId,
}) => (
  <div
    data-testid={testId}
    className={cn(
      'flex items-center gap-2 px-3 py-2.5 text-sm',
      borderedFooter && 'border-t border-border/30 bg-muted/20'
    )}
  >
    {showCheckIcon && <Check size={14} className="flex-shrink-0 text-success" />}
    <span className="text-muted-foreground">{label}:</span>
    <span className="font-medium text-foreground">{value}</span>
    {sourceLabel && (
      <span className="text-xs text-muted-foreground">({sourceLabel})</span>
    )}
  </div>
);

// ============================================================================
// 组件实现
// ============================================================================

const AskUserBlockComponent: React.FC<BlockComponentProps> = React.memo(({ block }) => {
  const { t } = useTranslation('chatV2');
  const [hasResponded, setHasResponded] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [customInput, setCustomInput] = useState('');
  const [checkedIndices, setCheckedIndices] = useState<Set<number>>(new Set());
  const [draftSelectedIndex, setDraftSelectedIndex] = useState<number | null>(null);
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [pendingSandboxCandidate, setPendingSandboxCandidate] =
    useState<SandboxCandidateAnswer | null>(null);

  // Local state for optimistic UI before backend confirms
  const [localSelectedTexts, setLocalSelectedTexts] = useState<string[] | null>(null);
  const [localCustomText, setLocalCustomText] = useState<string | null>(null);
  const [localSource, setLocalSource] = useState<string | null>(null);

  // 解析块数据
  const askInput = block.toolInput as unknown as AskUserBlockInput | undefined;
  const askOutput = unwrapOutput(block.toolOutput);

  const questionsList = useMemo(
    () => (Array.isArray(askInput?.questions) ? askInput.questions : []),
    [askInput?.questions]
  );
  const safeQuestionIndex =
    questionsList.length > 0
      ? Math.min(Math.max(0, activeQuestionIndex), questionsList.length - 1)
      : 0;
  const activeQuestionItem =
    questionsList.length > 0 ? questionsList[safeQuestionIndex] : undefined;

  const question =
    activeQuestionItem?.question || askInput?.question || askOutput?.question || '';
  const rawOptions = activeQuestionItem?.options ?? askInput?.options;
  const options = useMemo(() => normalizeAskUserOptions(rawOptions ?? []), [rawOptions]);
  const multiple = activeQuestionItem?.multiple ?? askInput?.multiple ?? false;
  const allowCustom = activeQuestionItem?.allowCustom ?? askInput?.allowCustom ?? true;
  const context = activeQuestionItem?.context ?? askInput?.context;

  const rawPresentation = activeQuestionItem?.presentation ?? askInput?.presentation;
  const validPresentation = useMemo<AskUserPresentation | null>(() => {
    if (!rawPresentation || typeof rawPresentation !== 'object') return null;
    if (!isValidPresentationHtml(rawPresentation.html)) return null;
    return {
      html: rawPresentation.html,
      title:
        typeof rawPresentation.title === 'string' && rawPresentation.title.trim().length > 0
          ? rawPresentation.title.trim()
          : undefined,
    };
  }, [rawPresentation]);

  const htmlCanvas =
    typeof askInput?.html === 'string' && askInput.html.trim().length > 0
      ? askInput.html
      : typeof askOutput?.html === 'string' && askOutput.html.trim().length > 0
        ? askOutput.html
        : undefined;
  const uiSource =
    typeof askInput?.ui === 'string' && askInput.ui.trim().length > 0
      ? askInput.ui
      : typeof askOutput?.ui === 'string' && askOutput.ui.trim().length > 0
        ? askOutput.ui
        : undefined;
  const panelTitle =
    typeof askInput?.title === 'string' && askInput.title.trim().length > 0
      ? askInput.title
      : typeof askOutput?.title === 'string' && askOutput.title.trim().length > 0
        ? askOutput.title
        : undefined;
  const hasRichDecisionSurface = Boolean(htmlCanvas || uiSource);

  // Initialize checked indices for multi-select (pre-check recommended = index 0)
  // Use block.toolCallId as dep to uniquely identify each ask_user invocation
  useEffect(() => {
    if (multiple && options.length > 0) {
      setCheckedIndices(new Set([0]));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.toolCallId, safeQuestionIndex]);

  // 是否已经有结果（从持久化数据恢复，或工具已完成）
  const isResolved = Boolean(askOutput) || block.status === 'success' || block.status === 'error';

  // 最终显示的选择结果
  const resolvedTexts: string[] | null = askOutput?.selected ?? localSelectedTexts;
  const resolvedCustomText: string | null = askOutput?.custom_text ?? localCustomText;
  const resolvedSource = askOutput?.source ?? localSource;

  const parsedAnswerData = useMemo<unknown>(() => {
    if (!resolvedCustomText) return null;
    try {
      return JSON.parse(resolvedCustomText);
    } catch {
      return resolvedCustomText;
    }
  }, [resolvedCustomText]);

  const applySandboxDraftState = useCallback(
    (candidate: SandboxCandidateAnswer) => {
      if (candidate.selectedIndices.length > 0) {
        if (multiple) {
          setCheckedIndices(new Set(candidate.selectedIndices));
        } else {
          setDraftSelectedIndex(candidate.selectedIndices[0] ?? null);
        }
      }
      if (candidate.customText !== null) {
        setCustomInput(candidate.customText);
      } else if (!multiple && candidate.selectedTexts.length === 1 && allowCustom) {
        setCustomInput(candidate.selectedTexts[0]);
      }
    },
    [allowCustom, multiple]
  );

  // 监听来自 presentation.html 隔离沙箱的草稿同步与提交确认请求
  useEffect(() => {
    if (!validPresentation || isResolved || hasResponded) return;

    const handleSandboxMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') return;
      const msg = payload as Record<string, unknown>;
      const msgType =
        typeof msg.type === 'string'
          ? msg.type
          : typeof msg.__wbw === 'string'
            ? msg.__wbw
            : '';

      if (msgType === 'wbw:set-answer-draft' || msgType === 'wbw:answer-draft') {
        const rawValue =
          msg.answer !== undefined
            ? msg.answer
            : msg.data !== undefined
              ? msg.data
              : msg.payload !== undefined
                ? msg.payload
                : msg.value;
        const summary = typeof msg.summary === 'string' ? msg.summary : undefined;
        const candidate = parseSandboxCandidateAnswer(rawValue, options, summary);
        applySandboxDraftState(candidate);
        return;
      }

      if (
        msgType === 'wbw:submit-answer' ||
        msgType === 'wbw:answer-submit' ||
        msgType === 'openchamber:submit'
      ) {
        const rawValue =
          msg.answer !== undefined
            ? msg.answer
            : msg.data !== undefined
              ? msg.data
              : msg.payload !== undefined
                ? msg.payload
                : msg.value;
        const summary = typeof msg.summary === 'string' ? msg.summary : undefined;
        const candidate = parseSandboxCandidateAnswer(rawValue, options, summary);
        applySandboxDraftState(candidate);
        setPendingSandboxCandidate(candidate);
      }
    };

    window.addEventListener('message', handleSandboxMessage);
    return () => window.removeEventListener('message', handleSandboxMessage);
  }, [applySandboxDraftState, hasResponded, isResolved, options, validPresentation]);

  // 发送回答到后端 (unified for both modes)
  const handleSubmit = useCallback(
    async (
      selectedTexts: string[],
      selectedIndices: number[],
      customText: string | null,
      source: string
    ) => {
      if (hasResponded || isResponding || isResolved) return;

      setIsResponding(true);
      setSubmitError(null);
      setPendingSandboxCandidate(null);
      setLocalSelectedTexts(selectedTexts);
      setLocalCustomText(customText);
      setLocalSource(source);

      try {
        await invoke('chat_v2_ask_user_respond', {
          toolCallId: block.toolCallId,
          selectedTexts,
          selectedIndices,
          customText: customText || null,
          source,
        });
        setHasResponded(true);
      } catch (error: unknown) {
        console.error('[AskUserBlock] Failed to send response:', error);
        // P0 修复：提交失败时不再伪装成功；回滚乐观状态并展示可重试的错误
        setLocalSelectedTexts(null);
        setLocalCustomText(null);
        setLocalSource(null);
        const detail =
          typeof error === 'string'
            ? error
            : error instanceof Error
              ? error.message
              : '';
        setSubmitError(detail);
      } finally {
        setIsResponding(false);
      }
    },
    [block.toolCallId, hasResponded, isResponding, isResolved]
  );

  // Single-select: click option → immediately submit
  const handleSingleSelect = useCallback(
    (index: number, text: string) => {
      handleSubmit([text], [index], null, 'user_click');
    },
    [handleSubmit]
  );

  // Multi-select: toggle checkbox
  const handleToggleCheck = useCallback(
    (index: number) => {
      setCheckedIndices((prev) => {
        const next = new Set(prev);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    },
    []
  );

  // Multi-select: confirm button
  const handleMultiConfirm = useCallback(() => {
    const indices = Array.from(checkedIndices).sort((a, b) => a - b);
    const texts = indices.map((i) => options[i]?.label).filter(Boolean) as string[];
    const trimmedCustom = customInput.trim();

    let source: string;
    if (texts.length > 0 && trimmedCustom) {
      source = 'mixed';
    } else if (trimmedCustom) {
      source = 'custom_input';
    } else {
      source = 'user_click';
    }

    handleSubmit(texts, indices, trimmedCustom || null, source);
  }, [checkedIndices, options, customInput, handleSubmit]);

  // 处理自定义输入提交 (single-select mode only)
  const handleCustomSubmit = useCallback(() => {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    handleSubmit([], [], trimmed, 'custom_input');
  }, [customInput, handleSubmit]);

  const handleConfirmSandboxCandidate = useCallback(() => {
    if (!pendingSandboxCandidate) return;
    handleSubmit(
      pendingSandboxCandidate.selectedTexts,
      pendingSandboxCandidate.selectedIndices,
      pendingSandboxCandidate.customText,
      pendingSandboxCandidate.source
    );
  }, [handleSubmit, pendingSandboxCandidate]);

  // 新的提问到达时重置状态
  useEffect(() => {
    if (block.status === 'running') {
      setHasResponded(false);
      setIsResponding(false);
      setSubmitError(null);
      setCustomInput('');
      setCheckedIndices(new Set());
      setDraftSelectedIndex(null);
      setPendingSandboxCandidate(null);
      setLocalSelectedTexts(null);
      setLocalCustomText(null);
      setLocalSource(null);
    }
  }, [block.toolCallId, block.status]);

  // 来源文案映射
  const sourceLabel = useMemo(() => {
    switch (resolvedSource) {
      case 'user_click':
        return t('askUser.sourceUserClick');
      case 'custom_input':
        return t('askUser.sourceCustomInput');
      case 'mixed':
        return t('askUser.sourceMixed');
      case 'timeout':
        return t('askUser.sourceNoResponse');
      case 'channel_closed':
        return t('askUser.sourceChannelClosed');
      default:
        return resolvedSource || '';
    }
  }, [resolvedSource, t]);

  const renderOptionReason = useCallback(
    (option: AskUserOptionViewModel) => {
      if (!option.reason) return null;

      return (
        <CommonTooltip content={option.reason} delay={150} maxWidth={280}>
          {/* 不挂 onClick：CommonTooltip 仅对无自身点击行为的子元素启用触屏 tap 切换，
              否则 reason 在触屏上只能靠 hover 不可达（点击不会冒泡触发选项选择） */}
          <button
            type="button"
            aria-label={t('askUser.optionReasonLabel')}
            className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Info size={14} weight="bold" />
          </button>
        </CommonTooltip>
      );
    },
    [t]
  );

  // 如果没有输入数据（preparing 状态），显示加载中
  if (!askInput) {
    return (
      <div className="overflow-hidden rounded-lg border border-border/50 bg-card dark:bg-card/80">
        <AskUserHeader title={t('askUser.preparing')} isPreparing hasBorder={false} />
      </div>
    );
  }

  // ========== 内联画板 / OpenUI-Lang 生成式决策面板（支持活跃提交与已回答回显） ==========
  if (hasRichDecisionSurface) {
    const answered = isResolved || hasResponded;
    const summaryText =
      resolvedTexts && resolvedTexts.length > 0
        ? resolvedTexts.join(', ')
        : resolvedCustomText || t('askUser.noResponse');

    return (
      <div className="overflow-hidden rounded-lg border border-border/50 bg-card dark:bg-card/80">
        <AskUserHeader title={panelTitle || question} answered={answered} />

        {panelTitle && question && panelTitle !== question && (
          <div className="border-b border-border/30 px-3 py-1.5 text-xs text-foreground">
            {question}
          </div>
        )}

        {context && (
          <div className="border-b border-border/30 px-3 py-1.5 text-xs text-muted-foreground">
            {context}
          </div>
        )}

        {submitError !== null && (
          <AskUserSubmitErrorBanner
            error={submitError}
            title={t('askUser.submitFailed')}
            retryHint={t('askUser.submitRetryHint')}
          />
        )}

        <div className="p-3">
          {htmlCanvas ? (
            <InteractiveHtmlCanvas
              html={htmlCanvas}
              title={panelTitle || question || 'interactive-decision-canvas'}
              answer={parsedAnswerData}
              onSubmit={(data, summary) =>
                handleSubmit([summary], [], JSON.stringify(data), 'mixed')
              }
            />
          ) : uiSource ? (
            <OpenUILangRenderer
              source={uiSource}
              awaitAnswer
              disabled={isResponding || answered}
              answer={
                parsedAnswerData && typeof parsedAnswerData === 'object'
                  ? (parsedAnswerData as Record<string, unknown>)
                  : null
              }
              onSubmit={({ summary, data }) =>
                handleSubmit([summary], [], JSON.stringify(data), 'mixed')
              }
            />
          ) : null}
        </div>

        {answered && (
          <AskUserAnswerSummary
            testId="ask-user-rich-summary"
            label={t('askUser.selected')}
            value={summaryText}
            sourceLabel={resolvedSource ? sourceLabel : undefined}
            showCheckIcon
            borderedFooter
          />
        )}
      </div>
    );
  }

  // ========== 已回答状态：只读视图 ==========
  if (isResolved || hasResponded) {
    // Build display text from resolved data
    const displayParts: string[] = [];
    if (resolvedTexts && resolvedTexts.length > 0) {
      displayParts.push(resolvedTexts.join(', '));
    }
    if (resolvedCustomText) {
      displayParts.push(resolvedCustomText);
    }
    const displayText = displayParts.join(' + ') || t('askUser.noResponse');

    return (
      <div className="overflow-hidden rounded-lg border border-border/50 bg-card dark:bg-card/80">
        <AskUserHeader title={question} answered />
        <AskUserAnswerSummary
          label={t('askUser.selected')}
          value={displayText}
          sourceLabel={resolvedSource ? sourceLabel : undefined}
        />
      </div>
    );
  }

  // ========== 活跃状态：交互式提问卡片 ==========
  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-card dark:bg-card/80">
      {/* 多题切换栏 */}
      {questionsList.length > 1 && (
        <div
          data-testid="ask-user-question-switcher"
          className="flex items-center justify-between gap-2 border-b border-border/30 bg-muted/20 px-3 py-1.5"
        >
          <div className="flex flex-wrap items-center gap-1">
            {questionsList.map((item, idx) => {
              const active = idx === safeQuestionIndex;
              return (
                <button
                  key={item.id || idx}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setActiveQuestionIndex(idx);
                    setDraftSelectedIndex(null);
                    setPendingSandboxCandidate(null);
                  }}
                  className={cn(
                    'rounded px-2 py-0.5 text-xs transition-colors [@media(pointer:coarse)]:!min-h-11',
                    active
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  <span className="font-mono tabular-nums">{idx + 1}</span>
                  {item.header ? <span className="ml-1">{item.header}</span> : null}
                </button>
              );
            })}
          </div>
          <span className="font-mono tabular-nums text-xs text-muted-foreground">
            {safeQuestionIndex + 1} / {questionsList.length}
          </span>
        </div>
      )}

      {/* 头部：问题 */}
      <AskUserHeader title={question} />

      {/* 上下文说明 */}
      {context && (
        <div className="border-b border-border/30 px-3 py-1.5 text-xs text-muted-foreground">
          {context}
        </div>
      )}

      {/* 可视化提问受限沙箱预览（仅当 presentation.html 合法时挂载；确认权归属宿主） */}
      {validPresentation && (
        <div
          data-testid="ask-user-presentation-sandbox"
          className="border-b border-border/30 bg-muted/10 p-3"
        >
          {validPresentation.title && (
            <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              <span>{validPresentation.title}</span>
            </div>
          )}
          <InteractiveHtmlCanvas
            html={validPresentation.html}
            title={validPresentation.title || question || 'ask-user-presentation'}
            answer={parsedAnswerData}
            onSubmit={(data, summary) => {
              const candidate = parseSandboxCandidateAnswer(data, options, summary);
              applySandboxDraftState(candidate);
              setPendingSandboxCandidate(candidate);
            }}
          />
        </div>
      )}

      {/* 提交失败提示（内联，可直接重新选择/提交） */}
      {submitError !== null && (
        <AskUserSubmitErrorBanner
          error={submitError}
          title={t('askUser.submitFailed')}
          retryHint={t('askUser.submitRetryHint')}
        />
      )}

      {/* 选项列表 */}
      <div className="px-3 py-2.5 space-y-1.5">
        {multiple ? (
          // ===== Multi-select: checkboxes =====
          <>
            {options.map((option, index) => {
              const isRecommended = index === 0;
              const isChecked = checkedIndices.has(index);
              return (
                <label
                  key={index}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 transition-colors [@media(pointer:coarse)]:min-h-11',
                    isChecked
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : isRecommended
                        ? 'border-border/60 bg-muted/30 text-foreground hover:bg-muted/50'
                        : 'border-border/50 bg-card text-foreground hover:bg-muted/40',
                    isResponding && 'opacity-50 pointer-events-none'
                  )}
                >
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={() => handleToggleCheck(index)}
                    disabled={isResponding}
                  />
                  <span className="flex-1 text-sm text-foreground">{option.label}</span>
                  {renderOptionReason(option)}
                  {isRecommended && (
                    <span className="flex flex-shrink-0 items-center gap-1 text-xs text-primary">
                      <Star size={12} className="fill-current" />
                      {t('askUser.recommended')}
                    </span>
                  )}
                </label>
              );
            })}
          </>
        ) : (
          // ===== Single-select: buttons =====
          options.map((option, index) => {
            const isRecommended = index === 0;
            const isDraftSelected = draftSelectedIndex === index;
            return (
              <div
                key={index}
                data-draft-selected={isDraftSelected ? 'true' : undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border px-3 py-2 transition-colors',
                  isDraftSelected
                    ? 'border-primary/50 bg-primary/10 text-foreground'
                    : isRecommended
                      ? 'border-border/60 bg-muted/30 text-foreground hover:bg-muted/50'
                      : 'border-border/50 bg-card text-foreground hover:bg-muted/40',
                  isResponding && 'opacity-50'
                )}
              >
                <DsButton
                  variant={isRecommended ? 'primary' : 'ghost'}
                  size="sm"
                  aria-pressed={isDraftSelected}
                  onClick={() => handleSingleSelect(index, option.label)}
                  disabled={isResponding}
                  className="!h-auto !flex-1 !justify-start !p-0 text-left !bg-transparent !text-inherit hover:!bg-transparent [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!-my-2"
                >
                  <span className="flex-1">{option.label}</span>
                </DsButton>
                {renderOptionReason(option)}
                {isRecommended && (
                  <span className="flex flex-shrink-0 items-center gap-1 text-xs text-primary">
                    <Star className="w-3 h-3 fill-current" />
                    {t('askUser.recommended')}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Multi-select confirm button */}
      {multiple && (
        <div className="px-3 pb-2.5">
          <DsButton
            variant="primary"
            size="sm"
            onClick={handleMultiConfirm}
            disabled={isResponding || (checkedIndices.size === 0 && !customInput.trim())}
            className="w-full [@media(pointer:coarse)]:!min-h-11"
          >
            <Check size={14} className="mr-1.5" />
            {t('askUser.confirmSelection')}
          </DsButton>
        </div>
      )}

      {/* 自定义输入 (only when allowCustom is true) */}
      {allowCustom && (
        <div className="px-3 pb-2.5 flex gap-2">
          <Input
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (multiple) {
                  handleMultiConfirm();
                } else {
                  handleCustomSubmit();
                }
              }
            }}
            placeholder={t('askUser.customPlaceholder')}
            disabled={isResponding}
            className={cn(
              'flex-1 px-3 py-1.5 text-sm rounded-md border border-border/50 [@media(pointer:coarse)]:min-h-11',
              'bg-background placeholder:text-muted-foreground/50',
              'focus:outline-none focus:ring-1 focus:ring-ring',
              isResponding && 'opacity-50 cursor-not-allowed'
            )}
          />
          {!multiple && (
            <DsButton
              variant="primary"
              size="sm"
              onClick={handleCustomSubmit}
              disabled={isResponding || !customInput.trim()}
              iconOnly
              aria-label={t('askUser.send')}
              className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
            >
              <PaperPlaneRight size={14} />
            </DsButton>
          )}
        </div>
      )}

      {/* 宿主要素可信确认栏：沙箱请求提交时展示，需用户点击宿主「确认回答」才真正提交 */}
      {pendingSandboxCandidate && (
        <div
          data-testid="ask-user-sandbox-confirm-bar"
          className="flex flex-wrap items-center justify-between gap-2 border-t border-border/30 bg-muted/20 px-3 py-2 text-xs"
        >
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <span className="w-1.5 h-1.5 flex-shrink-0 rounded-full bg-primary" />
              <span>
                {t('chatV2:askUser.sandboxCandidateHint', '画板已填入候选回答，请核对后确认提交')}
              </span>
            </div>
            <div
              data-testid="ask-user-sandbox-candidate-summary"
              className="truncate pl-3 font-medium text-foreground"
            >
              {pendingSandboxCandidate.displaySummary}
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <DsButton
              variant="ghost"
              size="sm"
              data-testid="ask-user-sandbox-cancel-btn"
              onClick={() => setPendingSandboxCandidate(null)}
              disabled={isResponding}
              className="[@media(pointer:coarse)]:!min-h-11"
            >
              {t('chatV2:askUser.sandboxContinueEditing', '继续修改')}
            </DsButton>
            <DsButton
              variant="primary"
              size="sm"
              data-testid="ask-user-sandbox-confirm-btn"
              onClick={handleConfirmSandboxCandidate}
              disabled={isResponding}
              className="[@media(pointer:coarse)]:!min-h-11"
            >
              {t('chatV2:askUser.sandboxConfirmAnswer', '确认回答')}
            </DsButton>
          </div>
        </div>
      )}
    </div>
  );
});

// ============================================================================
// 注册块类型
// ============================================================================

blockRegistry.register('ask_user', {
  type: 'ask_user',
  component: AskUserBlockComponent,
  onAbort: 'keep-content',
});

export { AskUserBlockComponent };
export default AskUserBlockComponent;
