import React, { useEffect, useState } from 'react';
import {
  ArrowCounterClockwise,
  CaretDown,
  CircleNotch,
  Eye,
  EyeSlash,
  Lightning,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { TECHNICAL_INPUT_PROPS } from '@/components/ui/shad/technicalInputProps';
import { cn } from '@/utils/cn';
import type {
  ByokAutoProvisionSummary,
  ByokProviderPreset,
  ByokProvisionerState,
} from './types';
import { useByokAutoProvisioner } from './useByokAutoProvisioner';

export interface QuickByokProvisionerCardProps {
  mode?: 'onboarding' | 'settings';
  defaultCollapsed?: boolean;
  fetcher?: typeof fetch;
  autoProbeOnPaste?: boolean;
  onCompleted?: (summary: ByokAutoProvisionSummary) => void;
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
  fetcher,
  autoProbeOnPaste = false,
  onCompleted,
  onOpenFullSettings,
  className,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [isCollapsed, setIsCollapsed] = useState<boolean>(
    mode === 'settings' ? defaultCollapsed : false,
  );
  const [userToggledCollapse, setUserToggledCollapse] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [showCustomUrl, setShowCustomUrl] = useState(false);

  const provisioner = useByokAutoProvisioner({
    fetcher,
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

  const getLocalizedPresetName = (preset: ByokProviderPreset): string => {
    if (preset.i18nProviderKey) {
      return t(preset.i18nProviderKey, { defaultValue: preset.displayName });
    }
    return preset.displayName;
  };

  if (mode === 'settings' && isCollapsed && state === 'idle') {
    return (
      <div
        data-testid="byok-provisioner-collapsed"
        className={cn(
          'flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-border/35 bg-[var(--surface-elevated)] px-3.5 py-2.5',
          className,
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
          <span className="truncate text-xs text-muted-foreground">
            {t('settings:byok.collapsedPrompt', {
              defaultValue:
                'Paste one API key to auto-configure model slots and vector index in 10 seconds',
            })}
          </span>
        </div>
        <DsButton
          variant="ghost"
          size="sm"
          data-testid="byok-expand-button"
          onClick={() => {
            setUserToggledCollapse(true);
            setIsCollapsed(false);
          }}
        >
          {t('settings:byok.expandAction', { defaultValue: 'Quick Setup' })}
        </DsButton>
      </div>
    );
  }

  const [step1Status, step2Status, step3Status] = resolveStepStatuses(state);
  const steps: Array<{ key: string; label: string; status: StepStatus }> = [
    {
      key: 'detect',
      label: t('settings:byok.steps.detect', { defaultValue: 'Detect Provider' }),
      status: step1Status,
    },
    {
      key: 'probe',
      label: t('settings:byok.steps.probe', { defaultValue: 'Probe Models & Dim' }),
      status: step2Status,
    },
    {
      key: 'assign',
      label: t('settings:byok.steps.assign', { defaultValue: 'Assign 8 Slots' }),
      status: step3Status,
    },
  ];

  const isFinished = state === 'completed' || state === 'partial_chat_only';
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
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                state === 'completed'
                  ? 'bg-emerald-500'
                  : state === 'partial_chat_only'
                    ? 'bg-amber-500'
                    : state === 'error'
                      ? 'bg-destructive'
                      : 'bg-foreground/45',
              )}
            />
            <h2 className="text-sm font-medium text-foreground leading-snug">
              {t('settings:byok.cardTitle', { defaultValue: '1-Key Auto-Provisioner' })}
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            {t('settings:byok.cardSubtitle', {
              defaultValue:
                'Paste a single API key to detect provider, probe models, and configure vector indexing.',
            })}
          </p>
        </div>

        {mode === 'settings' && (
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="byok-collapse-button"
            onClick={() => {
              setUserToggledCollapse(true);
              setIsCollapsed(true);
            }}
          >
            {t('settings:byok.collapseAction', { defaultValue: 'Collapse' })}
          </DsButton>
        )}
      </div>

      {/* Input Form */}
      {!isFinished && (
        <form
          className="space-y-2.5"
          onSubmit={(event) => {
            event.preventDefault();
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
                aria-label={t('settings:byok.keyInputAriaLabel', { defaultValue: 'API Key' })}
                placeholder={t('settings:byok.keyPlaceholder', {
                  defaultValue: 'Paste API Key (e.g. sk-... / AIzaSy... / sk-ant-...)',
                })}
                onChange={(event) => setRawApiKey(event.target.value)}
                onPaste={(event) => {
                  const text = event.clipboardData?.getData('text');
                  if (text) {
                    event.preventDefault();
                    handlePasteApiKey(text);
                  }
                }}
                className="pr-9 font-mono text-xs"
              />
              <button
                type="button"
                tabIndex={-1}
                aria-label={
                  revealed
                    ? t('settings:byok.hideKey', { defaultValue: 'Hide API key' })
                    : t('settings:byok.showKey', { defaultValue: 'Show API key' })
                }
                onClick={() => setRevealed((prev) => !prev)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                {revealed ? <EyeSlash size={15} /> : <Eye size={15} />}
              </button>
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
                  ? t('settings:byok.provisioningBusy', {
                      defaultValue: 'Probing & Configuring...',
                    })
                  : t('settings:byok.provisionCta', {
                      defaultValue: 'Probe & Auto-Configure',
                    })}
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
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                    <ProviderIcon
                      modelId={detection.preset.iconModelId}
                      size={14}
                      showTooltip={false}
                      variant="color"
                    />
                    <span className="truncate">
                      {t('settings:byok.detectedProvider', {
                        provider: getLocalizedPresetName(detection.preset),
                        defaultValue: `Detected: ${getLocalizedPresetName(detection.preset)}`,
                      })}
                    </span>
                  </div>
                )}

              {detection.sanitizedApiKey.length > 0 && detection.isAmbiguous && (
                <div
                  data-testid="byok-ambiguous-chip"
                  className="inline-flex items-center gap-1.5 text-muted-foreground"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                  <span>
                    {t('settings:byok.disambiguatePrompt', {
                      defaultValue: 'Generic sk- key detected. Pick a provider or auto-probe:',
                    })}
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
                {t('settings:byok.toggleCustomUrl', { defaultValue: 'Custom Base URL' })}
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
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                <span>{t('settings:byok.autoDetectPill', { defaultValue: 'Auto-Probe' })}</span>
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
                {t('settings:byok.baseUrlLabel', {
                  defaultValue: 'Custom Base URL (Optional)',
                })}
              </label>
              <Input
                {...TECHNICAL_INPUT_PROPS}
                id="byok-custom-base-url"
                data-testid="byok-custom-base-url"
                value={customBaseUrl}
                disabled={isBusy}
                onChange={(event) => setCustomBaseUrl(event.target.value)}
                placeholder={t('settings:byok.baseUrlPlaceholder', {
                  defaultValue: 'https://api.example.com/v1',
                })}
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
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  step.status === 'done'
                    ? 'bg-emerald-500'
                    : step.status === 'active'
                      ? 'bg-amber-500 animate-pulse'
                      : 'bg-foreground/20',
                )}
              />
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
          className="border border-border/35 px-3 py-2.5"
        >
          <div className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
            <AlertDescription className="text-xs text-destructive leading-relaxed">
              {error.message}
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Completed Full RAG + 8 Slots Summary */}
      {state === 'completed' && summary && (
        <div data-testid="byok-completed-summary" className="space-y-3 pt-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
              <ProviderIcon
                modelId={summary.preset.iconModelId}
                size={15}
                showTooltip={false}
                variant="color"
              />
              <span className="text-xs font-medium text-foreground">
                {t('settings:byok.result.fullReadyTitle', {
                  defaultValue: 'Models and Vector Index Configured',
                })}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                variant="secondary"
                data-testid="byok-vector-dimension-badge"
                className="gap-1.5 border border-border/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-normal"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span className="font-mono tabular-nums">{summary.dimension}</span>
                <span>
                  {t('settings:byok.vectorReadyBadge', {
                    dimension: summary.dimension,
                    defaultValue: `Vector Index Ready · ${summary.dimension} dim`,
                  })}
                </span>
              </Badge>
              <span className="rounded border border-border/35 px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-muted-foreground">
                {summary.latencyMs} ms
              </span>
            </div>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed font-mono tabular-nums">
            {t('settings:byok.result.fullReadySummary', {
              modelCount: summary.enabledModelCount,
              slotCount: summary.assignedSlotCount,
              dimension: summary.dimension,
              defaultValue: `Enabled ${summary.enabledModelCount} core models, populated ${summary.assignedSlotCount} slots, and bound ${summary.dimension}-dim vector index.`,
            })}
          </p>

          {summary.keptExistingDefaultDimension !== null && (
            <p className="text-xs text-muted-foreground font-mono tabular-nums">
              {t('settings:byok.vectorPreservedHint', {
                existingDimension: summary.keptExistingDefaultDimension,
                dimension: summary.dimension,
                defaultValue: `Kept existing default vector index (${summary.keptExistingDefaultDimension} dim) and bound the new model to ${summary.dimension} dim.`,
              })}
            </p>
          )}
        </div>
      )}

      {/* Chat-Only Fallback Banner */}
      {state === 'partial_chat_only' && summary && (
        <Alert
          data-testid="byok-chat-only-banner"
          className="border border-border/35 bg-muted/40 px-3.5 py-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              <div className="min-w-0 space-y-1">
                <AlertTitle className="text-xs font-medium text-foreground">
                  {t('settings:byok.result.chatOnlyTitle', {
                    defaultValue: 'Chat & Study Models Ready (No Embedding Model Found)',
                  })}
                </AlertTitle>
                <AlertDescription className="text-xs text-muted-foreground leading-relaxed">
                  {t('settings:byok.result.chatOnlyDescription', {
                    slotCount: summary.assignedSlotCount,
                    defaultValue: `Populated ${summary.assignedSlotCount} chat and specialist slots. This provider has no Embeddings endpoint, so Library RAG will run in keyword FTS mode until an embedding key is added.`,
                  })}
                </AlertDescription>
              </div>
            </div>
            <span className="shrink-0 rounded border border-border/35 px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-muted-foreground">
              {summary.latencyMs} ms
            </span>
          </div>
        </Alert>
      )}

      {/* Compact 2-Column 8-Slot Assignment Grid */}
      {isFinished && summary && (
        <div
          data-testid="byok-slots-grid"
          className="grid grid-cols-1 gap-1.5 pt-2.5 border-t border-border/35 sm:grid-cols-2"
        >
          {summary.slots.map((slot) => (
            <div
              key={slot.roleId}
              className="flex items-center justify-between gap-2 rounded-md border border-border/35 bg-background/50 px-2.5 py-1.5 text-xs"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    slot.configId ? 'bg-emerald-500' : 'bg-foreground/20',
                  )}
                />
                <span className="font-mono tabular-nums text-muted-foreground">
                  {slot.slotNumber}.
                </span>
                <span className="truncate text-foreground/85">
                  {t(`settings:byok.roles.${slot.roleId}`, {
                    defaultValue: slot.roleId,
                  })}
                </span>
              </div>
              <span className="max-w-[46%] truncate font-mono tabular-nums text-[11px] text-muted-foreground">
                {slot.modelLabel ??
                  (slot.preservedExisting && slot.configId
                    ? t('settings:config_status.configured', { defaultValue: 'Configured' })
                    : t('settings:byok.roleUnassigned', { defaultValue: 'Unassigned' }))}
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
              {t('settings:byok.resetAction', { defaultValue: 'Configure Another Key' })}
            </span>
          </DsButton>

          <div className="flex items-center gap-2">
            {mode === 'onboarding' && onOpenFullSettings && (
              <DsButton variant="ghost" size="sm" onClick={onOpenFullSettings}>
                {t('settings:byok.fullSettingsLink', { defaultValue: 'Open Full Settings' })}
              </DsButton>
            )}
            {mode === 'onboarding' && onCompleted && (
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
                {t('settings:byok.result.enterAppCta', { defaultValue: 'Start Learning' })}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default QuickByokProvisionerCard;
