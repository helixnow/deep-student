import React, { useEffect, useState } from 'react';
import {
  ArrowCounterClockwise,
  CaretDown,
  Check,
  CircleNotch,
  DownloadSimple,
  Eye,
  EyeSlash,
  Lightning,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { TECHNICAL_INPUT_PROPS } from '@/components/ui/shad/technicalInputProps';
import { cn } from '@/utils/cn';
import { ExternalToolImportPanel } from './ExternalToolImportPanel';
import {
  looksLikeStructuredExternalConfig,
  type ExternalLlmImportResult,
} from './externalImportApi';
import { BYOK_PRESETS } from './keyDetector';
import type {
  ByokAutoProvisionSummary,
  ByokProviderPreset,
  ByokProvisionerState,
  ByokSlotRoleId,
} from './types';
import { useByokAutoProvisioner } from './useByokAutoProvisioner';

const LEARNER_ROLE_LABELS: Readonly<Record<ByokSlotRoleId, { zh: string; en: string }>> = {
  primary_chat: { zh: '日常问答与解题', en: 'Chat & Problem Solving' },
  fast_utility: { zh: '快速摘要与标题', en: 'Quick Summaries & Titles' },
  summary_memory: { zh: '笔记整理与回顾', en: 'Notes & Study Memory' },
  coding_agent: { zh: '练习生成与辅助', en: 'Practice & Study Helper' },
  vision_parse: { zh: '图片与拍题识别', en: 'Image & Problem Reading' },
  document_ocr: { zh: 'PDF 与文档识别', en: 'PDF & Document Reading' },
  text_embedding: { zh: '资料智能搜索', en: 'Smart Material Search' },
  rag_reranker: { zh: '搜索结果精选', en: 'Search Result Ranking' },
};

export interface QuickByokProvisionerCardProps {
  mode?: 'onboarding' | 'settings';
  defaultCollapsed?: boolean;
  externalImportTriggerSeq?: number;
  fetcher?: typeof fetch;
  autoProbeOnPaste?: boolean;
  onCompleted?: (summary: ByokAutoProvisionSummary) => void;
  onReadyStateChange?: (ready: boolean) => void;
  /** 宿主弹窗（如 WelcomeOnboardingDialog）自带底部主导航按钮时，隐藏卡内重复的「前往设置/开始学习」按钮 */
  hideFooterNavigationActions?: boolean;
  onExternalImported?: (result: ExternalLlmImportResult) => void;
  onOpenFullSettings?: () => void;
  className?: string;
}

type StepStatus = 'pending' | 'active' | 'done';

function resolveStepStatuses(state: ByokProvisionerState): [StepStatus, StepStatus, StepStatus] {
  switch (state) {
    case 'idle':
      return ['pending', 'pending', 'pending'];
    case 'detecting':
      return ['active', 'pending', 'pending'];
    case 'probing':
      return ['done', 'active', 'pending'];
    case 'provisioning':
      return ['done', 'done', 'active'];
    case 'completed':
    case 'partial_chat_only':
      return ['done', 'done', 'done'];
    case 'error':
      return ['done', 'pending', 'pending'];
  }
}

export const QuickByokProvisionerCard: React.FC<QuickByokProvisionerCardProps> = ({
  mode = 'settings',
  defaultCollapsed = false,
  externalImportTriggerSeq,
  fetcher,
  autoProbeOnPaste = false,
  onCompleted,
  onReadyStateChange,
  hideFooterNavigationActions = false,
  onExternalImported,
  onOpenFullSettings,
  className,
}) => {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const isZh = (i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN').toLowerCase().startsWith('zh');
  const [isCollapsed, setIsCollapsed] = useState<boolean>(
    mode === 'settings' ? defaultCollapsed : false,
  );
  const [userToggledCollapse, setUserToggledCollapse] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [showCustomUrl, setShowCustomUrl] = useState(false);
  const [entryTab, setEntryTab] = useState<'key' | 'import'>('key');
  const [externalInitialText, setExternalInitialText] = useState('');
  const [panelTriggerSeq, setPanelTriggerSeq] = useState(0);
  const [externalImportDone, setExternalImportDone] = useState<ExternalLlmImportResult | null>(null);

  const openExternalImport = (snippet = '') => {
    setUserToggledCollapse(true);
    setIsCollapsed(false);
    setExternalInitialText(snippet);
    setEntryTab('import');
    setPanelTriggerSeq((prev) => prev + 1);
  };

  useEffect(() => {
    if (externalImportTriggerSeq && externalImportTriggerSeq > 0) {
      openExternalImport('');
    }
  }, [externalImportTriggerSeq]);

  const handleExternalImported = (result: ExternalLlmImportResult) => {
    onExternalImported?.(result);
    if (mode === 'onboarding') {
      setExternalImportDone(result);
    } else {
      setEntryTab('key');
      setUserToggledCollapse(true);
      setIsCollapsed(true);
    }
  };

  const provisioner = useByokAutoProvisioner({
    fetcher,
    mode,
    autoProbeOnPaste,
  });

  const {
    state,
    rawApiKey,
    customBaseUrl,
    selectedPresetId,
    detection,
    summary,
    error,
    isBusy,
    setRawApiKey,
    handlePasteApiKey,
    setCustomBaseUrl,
    setSelectedPresetId,
    submitProvision,
    reset,
  } = provisioner;

  useEffect(() => {
    if (mode === 'settings' && !userToggledCollapse && state === 'idle' && !rawApiKey) {
      setIsCollapsed(defaultCollapsed);
    }
  }, [defaultCollapsed, mode, rawApiKey, state, userToggledCollapse]);

  useEffect(() => {
    if (error && (error.code === 'network_timeout' || error.code === 'auth_failed')) {
      if (detection.isAmbiguous) {
        setShowCustomUrl(true);
      }
    }
  }, [detection.isAmbiguous, error]);

  const isProvisionFinished =
    state === 'completed' || state === 'partial_chat_only' || externalImportDone !== null;

  useEffect(() => {
    onReadyStateChange?.(isProvisionFinished);
  }, [isProvisionFinished, onReadyStateChange]);

  const getLocalizedPresetName = (preset: ByokProviderPreset): string => {
    if (preset.i18nProviderKey) {
      return t(preset.i18nProviderKey, { defaultValue: preset.displayName });
    }
    return preset.displayName;
  };

  if (mode === 'settings' && isCollapsed && state === 'idle' && entryTab === 'key') {
    return (
      <div
        data-testid="byok-provisioner-collapsed"
        className={cn(
          'flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-border/35 bg-[var(--surface-elevated)] px-3.5 py-2.5',
          className,
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="truncate text-xs text-muted-foreground">
            {isZh
              ? '粘贴一个 API 密钥，几秒内自动配置对话、文档阅读与搜索所需的 AI 模型'
              : 'Paste one API key to automatically set up AI models for chat, reading, and search'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="byok-external-import-collapsed-btn"
            onClick={() => openExternalImport('')}
          >
            <DownloadSimple size={14} />
            <span>{t('settings:external_import.entry_short')}</span>
          </DsButton>
          <DsButton
            variant="primary"
            size="sm"
            data-testid="byok-expand-button"
            className="shrink-0 rounded-xl border-primary/35 bg-primary/12 px-3 font-medium text-primary hover:bg-primary/20"
            onClick={() => {
              setUserToggledCollapse(true);
              setIsCollapsed(false);
            }}
          >
            {isZh ? '快速连接' : 'Quick Setup'}
          </DsButton>
        </div>
      </div>
    );
  }

  const [step1Status, step2Status, step3Status] = resolveStepStatuses(state);
  const steps: Array<{ key: string; label: string; status: StepStatus }> = [
    {
      key: 'detect',
      label: isZh ? '识别服务商' : 'Identify provider',
      status: step1Status,
    },
    {
      key: 'probe',
      label: isZh ? '检查可用模型' : 'Check available models',
      status: step2Status,
    },
    {
      key: 'assign',
      label: isZh ? '配置学习功能' : 'Set up study features',
      status: step3Status,
    },
  ];

  const isFinished = isProvisionFinished;
  const showDisambiguationPills =
    !isFinished &&
    detection.sanitizedApiKey.length > 0 &&
    detection.candidates.length > 0 &&
    !detection.usedCustomBaseUrl;

  return (
    <div
      data-testid="byok-provisioner-card"
      className={cn(
        'rounded-[var(--radius-card)] border border-border/35 bg-[var(--surface-elevated)] p-4 space-y-3',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground leading-snug">
            {isZh ? '连接 AI 模型服务' : 'Connect an AI Service'}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            {entryTab === 'import' && !isFinished
              ? t('settings:external_import.description')
              : isZh
                ? '粘贴一个服务商 API 密钥，自动识别服务商并配置日常对话、文档阅读与资料搜索。'
                : 'Paste a single provider API key to identify your provider and set up chat, reading, and material search.'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {!isFinished && (
            <SegmentedControl<'key' | 'import'>
              ariaLabel={t('settings:external_import.mode_switch_aria')}
              size="compact"
              value={entryTab}
              onValueChange={(next) => {
                setEntryTab(next);
                if (next === 'import') {
                  setExternalInitialText('');
                  setPanelTriggerSeq((prev) => prev + 1);
                }
              }}
              options={[
                { value: 'key', label: isZh ? '粘贴密钥' : 'Paste Key' },
                { value: 'import', label: t('settings:external_import.entry_short') },
              ]}
            />
          )}
          {mode === 'settings' && (
            <DsButton
              variant="ghost"
              size="sm"
              data-testid="byok-collapse-button"
              onClick={() => {
                setEntryTab('key');
                setUserToggledCollapse(true);
                setIsCollapsed(true);
              }}
            >
              {isZh ? '收起' : 'Collapse'}
            </DsButton>
          )}
        </div>
      </div>

      {/* Inline External Tool Import Panel */}
      {!isFinished && entryTab === 'import' && (
        <ExternalToolImportPanel
          initialTextInput={externalInitialText}
          triggerSeq={panelTriggerSeq}
          onCancel={() => setEntryTab('key')}
          onImported={handleExternalImported}
        />
      )}

      {/* Input Form */}
      {!isFinished && entryTab === 'key' && (
        <form
          className="space-y-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (looksLikeStructuredExternalConfig(rawApiKey)) {
              const snippet = rawApiKey;
              setRawApiKey('');
              openExternalImport(snippet);
              return;
            }
            void submitProvision();
          }}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1 min-w-0">
              <Input
                {...TECHNICAL_INPUT_PROPS}
                data-testid="byok-key-input"
                type={revealed ? 'text' : 'password'}
                value={rawApiKey}
                autoFocus={mode === 'onboarding'}
                disabled={isBusy}
                aria-label={isZh ? 'API 密钥' : 'API Key'}
                placeholder={t('settings:external_import.quick_input_placeholder')}
                onChange={(event) => setRawApiKey(event.target.value)}
                onPaste={(event) => {
                  const text = event.clipboardData?.getData('text');
                  if (text) {
                    event.preventDefault();
                    if (looksLikeStructuredExternalConfig(text)) {
                      openExternalImport(text);
                      return;
                    }
                    handlePasteApiKey(text);
                  }
                }}
                className="pr-12 font-mono text-xs truncate"
              />
              <DsButton
                type="button"
                variant="ghost"
                size="icon"
                iconOnly
                tabIndex={-1}
                aria-label={
                  revealed
                    ? (isZh ? '隐藏密钥' : 'Hide API key')
                    : (isZh ? '显示密钥' : 'Show API key')
                }
                onClick={() => setRevealed((prev) => !prev)}
                className="absolute right-0.5 top-1/2 -translate-y-1/2 !h-8 !w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground hover:text-foreground"
              >
                {revealed ? <EyeSlash size={15} /> : <Eye size={15} />}
              </DsButton>
            </div>

            <button
              type="submit"
              data-testid="byok-submit-button"
              disabled={isBusy || !detection.sanitizedApiKey}
              className={cn(
                'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-control px-3.5 text-xs font-medium transition-colors',
                'bg-foreground text-background hover:bg-foreground/90',
                'disabled:opacity-40 disabled:pointer-events-none',
                '[@media(pointer:coarse)]:!min-h-11',
              )}
            >
              {isBusy ? (
                <CircleNotch size={14} className="animate-spin" />
              ) : (
                <Lightning size={14} weight="fill" />
              )}
              <span>
                {isBusy
                  ? (isZh ? '正在连接并配置…' : 'Connecting & setting up…')
                  : (isZh ? '一键连接并配置' : 'Connect & Set Up')}
              </span>
            </button>
          </div>

          {/* Detected Provider Chip + Custom URL Toggle */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              {detection.sanitizedApiKey.length > 0 &&
                detection.preset &&
                !detection.isAmbiguous && (
                  <div
                    data-testid="byok-detected-chip"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/35 bg-background/70 px-2 py-1 text-foreground/90"
                  >
                    <ProviderIcon
                      modelId={detection.preset.iconModelId}
                      size={14}
                      showTooltip={false}
                      variant="color"
                    />
                    <span className="truncate">
                      {isZh
                        ? `已识别服务商：${getLocalizedPresetName(detection.preset)}`
                        : `Provider detected: ${getLocalizedPresetName(detection.preset)}`}
                    </span>
                  </div>
                )}

              {detection.sanitizedApiKey.length > 0 && detection.isAmbiguous && (
                <div
                  data-testid="byok-ambiguous-chip"
                  className="inline-flex items-center gap-1.5 text-muted-foreground"
                >
                  <span>
                    {isZh
                      ? '请选择你的服务商，或让系统自动识别：'
                      : 'Choose your provider, or let us detect it automatically:'}
                  </span>
                </div>
              )}
            </div>

            <button
              type="button"
              data-testid="byok-toggle-custom-url"
              onClick={() => setShowCustomUrl((prev) => !prev)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <span>
                {isZh ? '自定义服务地址' : 'Custom server address'}
              </span>
              <CaretDown
                size={12}
                className={cn('transition-transform', showCustomUrl && 'rotate-180')}
              />
            </button>
          </div>

          {/* Ambiguous sk-* Provider Pills */}
          {showDisambiguationPills && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="byok-candidate-pills">
              <button
                type="button"
                onClick={() => setSelectedPresetId(null)}
                disabled={isBusy}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                  selectedPresetId === null
                    ? 'border-foreground/40 bg-foreground/[0.07] font-medium text-foreground'
                    : 'border-border/35 bg-background/50 text-muted-foreground hover:text-foreground',
                )}
              >
                <span>{isZh ? '自动识别' : 'Auto-detect'}</span>
              </button>

              {detection.candidates.map((candidate) => {
                const isSelected = selectedPresetId === candidate.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    data-testid={`byok-pill-${candidate.id}`}
                    onClick={() => setSelectedPresetId(candidate.id)}
                    disabled={isBusy}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                      isSelected
                        ? 'border-foreground/40 bg-foreground/[0.07] font-medium text-foreground'
                        : 'border-border/35 bg-background/50 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <ProviderIcon
                      modelId={candidate.iconModelId}
                      size={13}
                      showTooltip={false}
                      variant="color"
                    />
                    <span>{getLocalizedPresetName(candidate)}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Expandable Custom Base URL Input */}
          {showCustomUrl && (
            <div className="space-y-1.5 pt-2 border-t border-border/35">
              <label
                htmlFor="byok-custom-base-url"
                className="block text-xs text-muted-foreground"
              >
                {isZh ? '自定义服务地址（可选）' : 'Custom server address (optional)'}
              </label>
              <Input
                {...TECHNICAL_INPUT_PROPS}
                id="byok-custom-base-url"
                data-testid="byok-custom-base-url"
                value={customBaseUrl}
                disabled={isBusy}
                onChange={(event) => setCustomBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
                className="font-mono text-xs"
              />
            </div>
          )}
        </form>
      )}

      {/* Live 3-Step Progress Stepper */}
      {state !== 'idle' && (
        <div
          data-testid="byok-progress-stepper"
          className="grid grid-cols-3 divide-x divide-border/35 rounded-md border border-border/35 bg-background/60"
        >
          {steps.map((step, index) => (
            <div
              key={step.key}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs min-w-0"
            >
              {step.status === 'done' ? (
                <Check size={12} weight="bold" className="shrink-0 text-success" />
              ) : step.status === 'active' ? (
                <CircleNotch size={12} className="shrink-0 text-primary animate-spin motion-reduce:animate-none" />
              ) : null}
              <span className="font-mono tabular-nums text-muted-foreground">
                {index + 1}.
              </span>
              <span
                className={cn(
                  'truncate',
                  step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground',
                )}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Error State */}
      {state === 'error' && error && (
        <Alert
          variant="destructive"
          data-testid="byok-error-alert"
          className="border border-destructive/30 px-3 py-2.5"
        >
          <AlertDescription className="text-xs text-destructive leading-relaxed">
            {error.message}
          </AlertDescription>
        </Alert>
      )}

      {/* Completed Full Study Features Summary */}
      {state === 'completed' && summary && (
        <div data-testid="byok-completed-summary" className="space-y-3 pt-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <ProviderIcon
                modelId={summary.preset.iconModelId}
                size={15}
                showTooltip={false}
                variant="color"
              />
              <span className="text-xs font-medium text-foreground">
                {isZh ? 'AI 学习助手已就绪' : 'Your AI study assistant is ready'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                variant="secondary"
                data-testid="byok-vector-dimension-badge"
                className="gap-1.5 border border-success/25 bg-success/10 text-success font-normal"
              >
                {summary.dimension !== null && (
                  <span className="font-mono tabular-nums">{summary.dimension}</span>
                )}
                <span>{isZh ? '资料智能搜索已就绪' : 'Smart search ready'}</span>
              </Badge>
            </div>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            {isZh
              ? `已启用 ${summary.enabledModelCount} 个模型，完成 ${summary.assignedSlotCount} 项学习功能配置，并开启资料智能搜索。`
              : `Enabled ${summary.enabledModelCount} models across ${summary.assignedSlotCount} study features, with smart material search ready.`}
          </p>

          {summary.keptExistingDefaultDimension !== null && (
            <p className="text-xs text-muted-foreground">
              {isZh
                ? '已保留你现有的资料搜索配置，并关联了新的搜索模型。'
                : 'Kept your existing material search setup and linked the new search model.'}
            </p>
          )}
        </div>
      )}

      {/* Chat-Only Fallback Banner */}
      {state === 'partial_chat_only' && summary && (
        <Alert
          data-testid="byok-chat-only-banner"
          className="border border-warning/25 bg-warning/[0.06] px-3.5 py-3"
        >
          <div className="min-w-0 space-y-1">
            <AlertTitle className="text-xs font-medium text-foreground">
              {isZh ? 'AI 对话与学习功能已就绪' : 'AI chat & study features are ready'}
            </AlertTitle>
            <AlertDescription className="text-xs text-muted-foreground leading-relaxed">
              {isZh
                ? `已为你配置 ${summary.assignedSlotCount} 项对话与学习功能。当前服务商暂未提供语义搜索模型，资料库将先使用关键词搜索；你随时可以在设置中补充支持语义搜索的服务。`
                : `Set up ${summary.assignedSlotCount} chat and study features. This provider does not offer semantic search yet, so your library will use keyword search for now—you can add one anytime in Settings.`}
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Compact Study Feature Assignment List */}
      {isFinished && summary && (
        <div
          data-testid="byok-slots-grid"
          className="divide-y divide-border/35 border-t border-border/35 pt-1"
        >
          {summary.slots.map((slot) => (
            <div
              key={slot.roleId}
              className="flex items-center justify-between gap-2 px-1 py-1.5 text-xs"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="font-mono tabular-nums text-muted-foreground">
                  {slot.slotNumber}.
                </span>
                <span className={cn('truncate', slot.configId ? 'text-foreground/90' : 'text-muted-foreground')}>
                  {isZh ? LEARNER_ROLE_LABELS[slot.roleId].zh : LEARNER_ROLE_LABELS[slot.roleId].en}
                </span>
              </div>
              <span className="max-w-[48%] truncate font-mono tabular-nums text-[11px] text-muted-foreground">
                {slot.modelLabel ??
                  (slot.preservedExisting && slot.configId
                    ? (isZh ? '已配置' : 'Configured')
                    : (isZh ? '暂未启用' : 'Optional'))}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Post-Provision Actions */}
      {isFinished && summary && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-border/35">
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="byok-reset-button"
            onClick={reset}
          >
            <ArrowCounterClockwise size={14} />
            <span>
              {isZh ? '换一个密钥' : 'Use Another Key'}
            </span>
          </DsButton>

          {mode === 'onboarding' && !hideFooterNavigationActions && (onOpenFullSettings || onCompleted) && (
            <div className="flex items-center gap-2">
              {onOpenFullSettings && (
                <DsButton variant="ghost" size="sm" onClick={onOpenFullSettings}>
                  {isZh ? '前往完整模型设置' : 'Open AI Settings'}
                </DsButton>
              )}
              {onCompleted && (
                <button
                  type="button"
                  data-testid="byok-enter-app-button"
                  onClick={() => onCompleted(summary)}
                  className={cn(
                    'inline-flex h-9 items-center justify-center rounded-control px-4 text-xs font-medium transition-colors',
                    'bg-foreground text-background hover:bg-foreground/90',
                    '[@media(pointer:coarse)]:!min-h-11',
                  )}
                >
                  {isZh ? '开始学习' : 'Start Learning'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {/* Onboarding External Import Completed State */}
      {externalImportDone !== null && !summary && (
        <div data-testid="byok-external-import-summary" className="space-y-3 pt-1">
          <div className="flex items-center gap-2">
            <Check size={14} weight="bold" className="shrink-0 text-success" />
            <span className="text-xs font-medium text-foreground">
              {t('settings:external_import.notifications.import_success_title')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('settings:external_import.notifications.import_success_desc', {
              vendorCount:
                externalImportDone.importedVendorCount + externalImportDone.updatedVendorCount,
              modelCount: externalImportDone.importedModelCount,
              slotCount: externalImportDone.assignedSlotCount,
            })}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-border/35">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => {
                setExternalImportDone(null);
                reset();
              }}
            >
              <ArrowCounterClockwise size={14} />
              <span>{t('settings:external_import.actions.import_more_or_reset')}</span>
            </DsButton>
            {mode === 'onboarding' && !hideFooterNavigationActions && (onOpenFullSettings || onCompleted) && (
              <div className="flex items-center gap-2">
                {onOpenFullSettings && (
                  <DsButton variant="ghost" size="sm" onClick={onOpenFullSettings}>
                    {t('settings:byok.fullSettingsLink')}
                  </DsButton>
                )}
                {onCompleted && (
                  <DsButton
                    variant="primary"
                    size="sm"
                    data-testid="byok-external-enter-app-button"
                    className="h-9 rounded-control !border-transparent !bg-foreground px-4 text-xs font-medium !text-background hover:!bg-foreground/90 hover:!text-background active:!bg-foreground/85"
                    onClick={() =>
                      onCompleted({
                        status: 'completed',
                        preset: BYOK_PRESETS.custom,
                        baseUrl: '',
                        probedModelCount: externalImportDone.importedModelCount,
                        enabledModelCount: externalImportDone.importedModelCount,
                        assignedSlotCount: externalImportDone.assignedSlotCount,
                        slots: [],
                        dimension: null,
                        keptExistingDefaultDimension: null,
                        latencyMs: 0,
                      })
                    }
                  >
                    {t('settings:byok.result.enterAppCta')}
                  </DsButton>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default QuickByokProvisionerCard;
