import React from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Books,
  CaretDown,
  Cards,
  ChatCircleDots,
  Exam,
  FileText,
  FolderOpen,
  GearSix,
  Globe,
  Lightning,
  ListChecks,
  ShieldCheck,
  Stop,
  Timer,
  TreeStructure,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { setPendingSettingsTab } from '@/utils/pendingSettingsTab';
import { cn } from '@/lib/utils';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { workbenchBus } from '../core/workbenchBus';
import { useLiquidGlassLens } from '../core/liquidGlassLens';

import './AgentControlCenter.css';

export const AGENT_CONTROL_DOCK_ID = '__agent_control__';
export const AGENT_CONTROL_SETTING_KEY = 'desktop.workbenchAgentControl';
export const AGENT_CONTROL_DISCOVERY_SEEN_KEY = 'workbench.agentControl.discoverySeen.v1';
export const KILL_SWITCH_CHANGED_EVENT = 'chat_v2://kill_switch_changed';

export type AgentControlMode = 'off' | 'background' | 'follow';

export interface KillSwitchStatus {
  tripped: boolean;
  trippedAtMs?: number | null;
  reason?: string | null;
  automationsPaused: boolean;
  cancelledStreams?: number;
}

function parseKillSwitchStatus(raw: unknown): KillSwitchStatus {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    tripped: Boolean(
      value.killSwitchTripped ?? value.kill_switch_tripped ?? value.tripped,
    ),
    trippedAtMs:
      typeof value.trippedAtMs === 'number'
        ? value.trippedAtMs
        : typeof value.tripped_at_ms === 'number'
          ? value.tripped_at_ms
          : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    automationsPaused: Boolean(
      value.automationsPaused ?? value.automations_paused ?? false,
    ),
    cancelledStreams:
      typeof value.cancelledStreams === 'number'
        ? value.cancelledStreams
        : typeof value.cancelled_streams === 'number'
          ? value.cancelled_streams
          : undefined,
  };
}

const CAPABILITY_APP_IDS = [
  'note',
  'mindmap',
  'todo',
  'files',
  'exam',
  'flashcards',
  'pomodoro',
  'browser',
] as const;

const CAPABILITY_APP_ICONS = {
  note: FileText,
  mindmap: TreeStructure,
  todo: ListChecks,
  files: FolderOpen,
  exam: Exam,
  flashcards: Cards,
  pomodoro: Timer,
  browser: Globe,
};

const CAPABILITY_GROUPS = [
  { id: 'organize', icon: FileText },
  { id: 'study', icon: Books },
  { id: 'browse', icon: Globe },
] as const;

function parseAgentControlMode(raw: unknown): AgentControlMode {
  const value = String(raw ?? '').trim();
  if (!value) return 'follow';
  if (value === 'off' || value === 'background' || value === 'follow') return value;
  return 'off';
}

function readDiscoverySeen(): boolean {
  try {
    return localStorage.getItem(AGENT_CONTROL_DISCOVERY_SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

function markDiscoverySeen(): void {
  try {
    localStorage.setItem(AGENT_CONTROL_DISCOVERY_SEEN_KEY, '1');
  } catch {
    // Local UI preference only; a blocked storage backend is harmless.
  }
}

export interface AgentCapabilitySummaryProps {
  variant?: 'popover' | 'settings';
  className?: string;
}

/** Localized, deliberately bounded examples of the semantic capabilities ACR exposes. */
export function AgentCapabilitySummary({
  variant = 'popover',
  className,
}: AgentCapabilitySummaryProps) {
  const { t } = useTranslation('workbench');
  const [expanded, setExpanded] = React.useState(false);
  const showDetails = variant === 'settings' || expanded;

  return (
    <div className={cn('wb-agent-capabilities', className)} data-variant={variant}>
      <div className="wb-agent-capabilities-header">
        <div className="wb-agent-capabilities-heading">
          <h3 className="wb-agent-capabilities-title">
            {t('agentControlCenter.capabilitiesTitle')}
          </h3>
          {variant === 'popover' && (
            <span>{t('agentControlCenter.appCount')}</span>
          )}
        </div>
        {variant === 'popover' && (
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            className="wb-agent-capabilities-toggle [@media(pointer:coarse)]:!min-h-11"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <span>
              {expanded
                ? t('agentControlCenter.collapseCapabilities')
                : t('agentControlCenter.expandCapabilities')}
            </span>
            <CaretDown size={13} weight="bold" aria-hidden="true" />
          </DsButton>
        )}
      </div>

      {showDetails ? (
        <ul className="wb-agent-capabilities-list" data-view="details">
          {CAPABILITY_APP_IDS.map((appId) => {
            const CapabilityIcon = CAPABILITY_APP_ICONS[appId];
            return (
              <li key={appId} className="wb-agent-capability-row">
                <span className="wb-agent-capability-icon" aria-hidden="true">
                  <CapabilityIcon size={15} weight="duotone" />
                </span>
                <span className="wb-agent-capability-copy">
                  <span className="wb-agent-capability-app">
                    {t(`agentControlCenter.apps.${appId}.name`)}
                  </span>
                  <span className="wb-agent-capability-actions">
                    {t(`agentControlCenter.apps.${appId}.actions`)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="wb-agent-capability-groups" data-view="summary">
          {CAPABILITY_GROUPS.map((group) => {
            const GroupIcon = group.icon;
            return (
              <li key={group.id} className="wb-agent-capability-group">
                <span className="wb-agent-capability-group-icon" aria-hidden="true">
                  <GroupIcon size={16} weight="duotone" />
                </span>
                <span className="wb-agent-capability-group-copy">
                  <span>
                    {t(`agentControlCenter.groups.${group.id}.title`)}
                  </span>
                  <small>
                    {t(`agentControlCenter.groups.${group.id}.actions`)}
                  </small>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="wb-agent-capabilities-safety">
        <ShieldCheck size={15} weight="duotone" aria-hidden="true" />
        <span>
          {variant === 'popover'
            ? t('agentControlCenter.safetyCompact')
            : t('agentControlCenter.safety')}
        </span>
      </p>
    </div>
  );
}

export interface AgentControlDockEntryProps {
  tabIndex: number;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  onFocus?: () => void;
}

export function AgentControlDockEntry({
  tabIndex,
  buttonRef,
  onFocus,
}: AgentControlDockEntryProps) {
  const { t } = useTranslation('workbench');
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<AgentControlMode>('follow');
  const [loading, setLoading] = React.useState(true);
  const [saveError, setSaveError] = React.useState(false);
  const [seen, setSeen] = React.useState(readDiscoverySeen);
  const [killSwitch, setKillSwitch] = React.useState<KillSwitchStatus>({
    tripped: false,
    automationsPaused: false,
  });
  const [killSwitchBusy, setKillSwitchBusy] = React.useState(false);
  const [killSwitchError, setKillSwitchError] = React.useState<string | null>(null);
  /** Inline error for the automation recovery card (resume agents / resume automations). */
  const [automationError, setAutomationError] = React.useState<string | null>(null);
  const [confirmStop, setConfirmStop] = React.useState(false);
  const [confirmResumeAutomations, setConfirmResumeAutomations] = React.useState(false);
  const popoverRef = React.useRef<HTMLDivElement | null>(null);

  useLiquidGlassLens(popoverRef, open);

  const onSettingsChanged = React.useCallback((event: Event) => {
    const detail = (event as CustomEvent<{ key?: string; value?: unknown }>).detail;
    if (detail?.key === AGENT_CONTROL_SETTING_KEY) {
      setMode(parseAgentControlMode(detail.value));
      setLoading(false);
    }
  }, []);

  useEventRegistry(
    [{ target: 'window', type: 'workbench:settings-changed', listener: onSettingsChanged }],
    [onSettingsChanged],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (tauriInvoke('get_setting', { key: AGENT_CONTROL_SETTING_KEY }) as Promise<string | null>)
      .then((raw) => {
        if (!cancelled) setMode(parseAgentControlMode(raw));
      })
      .catch(() => {
        // The persisted setting defaults to follow; retain that fallback outside Tauri/tests.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    void (tauriInvoke('chat_v2_kill_switch_status') as Promise<unknown>)
      .then((raw) => {
        if (!cancelled) setKillSwitch(parseKillSwitchStatus(raw));
      })
      .catch(() => {
        // Kill switch status is optional outside Tauri/tests.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<unknown>(KILL_SWITCH_CHANGED_EVENT, (event) => {
      setKillSwitch(parseKillSwitchStatus(event.payload));
      setConfirmStop(false);
      setConfirmResumeAutomations(false);
      setKillSwitchError(null);
      setAutomationError(null);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Event bridge unavailable in pure vitest / non-Tauri shells.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const changeMode = React.useCallback(
    async (next: AgentControlMode) => {
      if (loading || next === mode) return;
      const previous = mode;
      setMode(next);
      setSaveError(false);
      try {
        await tauriInvoke('save_setting', { key: AGENT_CONTROL_SETTING_KEY, value: next });
        window.dispatchEvent(
          new CustomEvent('workbench:settings-changed', {
            detail: { key: AGENT_CONTROL_SETTING_KEY, value: next },
          }),
        );
      } catch {
        setMode(previous);
        setSaveError(true);
      }
    },
    [loading, mode],
  );

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (next && !seen) {
      setSeen(true);
      markDiscoverySeen();
    }
    if (!next) {
      setConfirmStop(false);
      setConfirmResumeAutomations(false);
      setKillSwitchError(null);
      setAutomationError(null);
    }
  }, [seen]);

  const openChat = React.useCallback(() => {
    handleOpenChange(false);
    void workbenchBus.activate({
      typeId: 'chat',
      instanceKey: '',
      action: 'focusInput',
      fallbackLaunch: { typeId: 'chat', reason: 'dock' },
    });
  }, [handleOpenChange]);

  const openControlSettings = React.useCallback(() => {
    handleOpenChange(false);
    setPendingSettingsTab('workbench');
    workbenchBus.launch({ typeId: 'settings', reason: 'dock' });
    dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'workbench' });
  }, [handleOpenChange]);

  const runEmergencyStop = React.useCallback(async () => {
    if (killSwitchBusy) return;
    setKillSwitchBusy(true);
    setKillSwitchError(null);
    try {
      const raw = await tauriInvoke('chat_v2_emergency_stop', {
        reason: 'user_emergency_stop',
      });
      setKillSwitch(parseKillSwitchStatus(raw));
      setConfirmStop(false);
    } catch {
      setKillSwitchError(t('agentControlCenter.killSwitch.stopFailed'));
    } finally {
      setKillSwitchBusy(false);
    }
  }, [killSwitchBusy, t]);

  const runResumeAgents = React.useCallback(async () => {
    if (killSwitchBusy) return;
    setKillSwitchBusy(true);
    setAutomationError(null);
    try {
      const raw = await tauriInvoke('chat_v2_resume_agents');
      setKillSwitch(parseKillSwitchStatus(raw));
    } catch {
      setAutomationError(t('agentControlCenter.killSwitch.resumeFailed'));
    } finally {
      setKillSwitchBusy(false);
    }
  }, [killSwitchBusy, t]);

  const runResumeAutomations = React.useCallback(async () => {
    if (killSwitchBusy) return;
    setKillSwitchBusy(true);
    setAutomationError(null);
    try {
      // Backend emits kill_switch_changed on success, so StatusBar and other
      // listeners refresh without any cross-component imports.
      const raw = await tauriInvoke('chat_v2_resume_automations');
      setKillSwitch(parseKillSwitchStatus(raw));
      setConfirmResumeAutomations(false);
    } catch {
      setAutomationError(t('agentControlCenter.killSwitch.resumeFailed'));
    } finally {
      setKillSwitchBusy(false);
    }
  }, [killSwitchBusy, t]);

  const statusLabel = t(`settings.agentControl.${mode}`);
  const showAutomationsPausedNotice =
    !killSwitch.tripped && killSwitch.automationsPaused;
  /** Automation scheduler card state: tripped > paused (KS cleared) > running. */
  const automationState: 'running' | 'tripped' | 'paused' = killSwitch.tripped
    ? 'tripped'
    : killSwitch.automationsPaused
      ? 'paused'
      : 'running';
  const baseTriggerLabel = t('agentControlCenter.triggerLabel', {
    status: statusLabel,
  });
  const triggerLabel = killSwitch.tripped
    ? `${baseTriggerLabel}. ${t('agentControlCenter.killSwitch.trippedBanner')}`
    : showAutomationsPausedNotice
      ? `${baseTriggerLabel}. ${t('agentControlCenter.killSwitch.automationsStillPaused')}`
      : baseTriggerLabel;

  return (
    <div
      data-testid={`wb-dock-item-${AGENT_CONTROL_DOCK_ID}`}
      data-wb-dock-item-wrap=""
      className="wb-dock-item-wrap relative flex flex-col items-center"
    >
      <div className="wb-dock-mag" data-wb-dock-mag-item={AGENT_CONTROL_DOCK_ID}>
        <div className="wb-dock-bounce">
          <Popover open={open} onOpenChange={handleOpenChange}>
            <PopoverTrigger asChild>
              <button
                ref={buttonRef}
                type="button"
                data-type-id={AGENT_CONTROL_DOCK_ID}
                data-testid="wb-dock-agent-control-button"
                data-mode={mode}
                data-kill-switch={killSwitch.tripped ? 'tripped' : undefined}
                data-unseen={!seen || undefined}
                className="wb-dock-item group relative flex h-11 w-11 items-center justify-center rounded-xl outline-none"
                aria-label={triggerLabel}
                tabIndex={tabIndex}
                onFocus={onFocus}
              >
                <span
                  aria-hidden="true"
                  className="wb-dock-item-icon pointer-events-none flex h-full w-full items-center justify-center"
                >
                  <img
                    src="/app-icon.png"
                    alt=""
                    className="wb-agent-control-app-icon"
                  />
                </span>
                {(killSwitch.tripped || showAutomationsPausedNotice) && (
                  <span
                    aria-hidden="true"
                    className="wb-agent-kill-dock-badge"
                    data-testid="wb-agent-kill-switch-dock-badge"
                    data-state={killSwitch.tripped ? 'tripped' : 'paused'}
                  />
                )}
              </button>
            </PopoverTrigger>

            <PopoverContent
              ref={popoverRef}
              side="top"
              align="end"
              sideOffset={32}
              collisionPadding={12}
              aria-label={t('agentControlCenter.title')}
              className="wb-agent-control-popover wb-glass wb-glass-highlight wb-glass-lens"
            >
              <CustomScrollArea
                className="wb-agent-control-scroll"
                onWheel={(event) => event.stopPropagation()}
                trackOffsetTop={6}
                trackOffsetBottom={6}
                trackOffsetRight={3}
              >
                <div className="wb-agent-control-header">
                  <div className="wb-agent-control-identity">
                    <span className="wb-agent-control-mark" data-mode={mode} aria-hidden="true">
                      <img
                        src="/app-icon.png"
                        alt=""
                        className="wb-agent-control-mark-icon"
                      />
                      <i />
                    </span>
                    <div>
                      <h2>{t('agentControlCenter.title')}</h2>
                      <p>
                        {t('agentControlCenter.description')}
                      </p>
                    </div>
                  </div>
                  <span className="wb-agent-control-mode-badge" data-mode={mode} aria-live="polite">
                    <i aria-hidden="true" />
                    {statusLabel}
                  </span>
                </div>

                <div className="wb-agent-control-mode-control">
                  <div className="wb-agent-control-mode-heading">
                    <span>{t('agentControlCenter.modeLabel')}</span>
                    <SegmentedControl
                      ariaLabel={t('settings.agentControl.title')}
                      value={mode}
                      onValueChange={(next) => void changeMode(next as AgentControlMode)}
                      size="compact"
                      className={cn('wb-agent-control-segmented', loading && 'opacity-50')}
                      itemClassName="[@media(pointer:coarse)]:!min-h-11"
                      options={([
                        { value: 'off', label: t('settings.agentControl.off') },
                        { value: 'background', label: t('settings.agentControl.background') },
                        { value: 'follow', label: t('settings.agentControl.follow') },
                      ] as const).map((option) => ({ ...option, disabled: loading }))}
                    />
                  </div>
                  <p className="wb-agent-control-mode-description">
                    {t(`agentControlCenter.modeDescriptions.${mode}`)}
                  </p>
                  {saveError && (
                    <p className="wb-agent-control-error" role="alert">
                      {t('agentControlCenter.saveFailed')}
                    </p>
                  )}
                </div>

                {/* Automation scheduling status card (always visible, three states) */}
                <div
                  className={cn(
                    'mx-3 mb-2 flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 transition-colors duration-150',
                    automationState === 'running' &&
                      'border-[var(--border-soft,hsl(var(--border)/38%))]',
                    automationState === 'paused' && 'border-amber-500/45 bg-amber-500/10',
                    automationState === 'tripped' && 'border-red-500/45 bg-red-500/10',
                  )}
                  data-testid="wb-agent-automation-card"
                  data-state={automationState}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full transition-colors duration-150',
                        automationState === 'running' && 'bg-emerald-500',
                        automationState === 'paused' && 'bg-amber-500',
                        automationState === 'tripped' && 'bg-red-500',
                      )}
                    />
                    <span className="flex items-center gap-1 text-xs font-semibold">
                      <Lightning size={12} weight="duotone" aria-hidden="true" />
                      {t('agentControlCenter.automationCard.title')}
                    </span>
                    {automationState === 'running' ? (
                      <span className="ml-auto text-2xs text-muted-foreground">
                        {t('agentControlCenter.automationCard.running')}
                      </span>
                    ) : null}
                  </div>

                  {automationState !== 'running' && (
                    <div
                      className="flex flex-col gap-1.5"
                      data-testid="wb-agent-kill-switch-banner"
                      role="status"
                      aria-live="assertive"
                      aria-atomic="true"
                      aria-busy={killSwitchBusy || undefined}
                    >
                      <p className="m-0 text-xs font-semibold leading-snug">
                        {automationState === 'tripped'
                          ? t('agentControlCenter.automationCard.tripped')
                          : t('agentControlCenter.automationCard.paused')}
                      </p>
                      <small className="text-2xs leading-snug text-muted-foreground">
                        {automationState === 'tripped'
                          ? t('agentControlCenter.automationCard.trippedHint')
                          : t('agentControlCenter.automationCard.pausedHint')}
                      </small>
                      {automationState === 'tripped' && killSwitch.reason ? (
                        <small className="text-2xs leading-snug text-muted-foreground">
                          {t('agentControlCenter.killSwitch.trippedReason', {
                            reason: killSwitch.reason,
                          })}
                        </small>
                      ) : null}
                      <div className="wb-agent-kill-banner-actions">
                        {automationState === 'tripped' ? (
                          <DsButton
                            type="button"
                            size="sm"
                            variant="shell"
                            className="[@media(pointer:coarse)]:!min-h-11"
                            disabled={killSwitchBusy}
                            data-testid="wb-agent-resume-agents"
                            onClick={() => void runResumeAgents()}
                          >
                            {t('agentControlCenter.killSwitch.resumeAgents')}
                          </DsButton>
                        ) : confirmResumeAutomations ? (
                          <>
                            <DsButton
                              type="button"
                              size="sm"
                              variant="shell"
                              className="[@media(pointer:coarse)]:!min-h-11"
                              disabled={killSwitchBusy}
                              data-testid="wb-agent-resume-automations-confirm"
                              onClick={() => void runResumeAutomations()}
                            >
                              {killSwitchBusy
                                ? t('agentControlCenter.automationCard.resuming')
                                : t('agentControlCenter.killSwitch.confirmResumeAutomations')}
                            </DsButton>
                            <DsButton
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="[@media(pointer:coarse)]:!min-h-11"
                              disabled={killSwitchBusy}
                              onClick={() => setConfirmResumeAutomations(false)}
                            >
                              {t('agentControlCenter.killSwitch.cancelConfirm')}
                            </DsButton>
                          </>
                        ) : (
                          <DsButton
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="[@media(pointer:coarse)]:!min-h-11"
                            disabled={killSwitchBusy}
                            data-testid="wb-agent-resume-automations"
                            onClick={() => setConfirmResumeAutomations(true)}
                          >
                            {t('agentControlCenter.killSwitch.resumeAutomations')}
                          </DsButton>
                        )}
                      </div>
                      {confirmResumeAutomations && automationState === 'paused' ? (
                        <small className="wb-agent-kill-confirm-copy">
                          {t('agentControlCenter.killSwitch.resumeAutomationsConfirm')}
                        </small>
                      ) : null}
                      {automationError ? (
                        <p className="wb-agent-control-error" role="alert">
                          {automationError}
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>

                <div
                  className="wb-agent-kill-switch"
                  data-testid="wb-agent-kill-switch"
                  aria-busy={killSwitchBusy || undefined}
                >
                  {confirmStop ? (
                    <div className="wb-agent-kill-confirm">
                      <p>{t('agentControlCenter.killSwitch.emergencyStopConfirm')}</p>
                      <div className="wb-agent-kill-banner-actions">
                        <DsButton
                          type="button"
                          size="sm"
                          className="wb-agent-emergency-stop [@media(pointer:coarse)]:!min-h-11"
                          disabled={killSwitchBusy}
                          data-testid="wb-agent-emergency-stop-confirm"
                          onClick={() => void runEmergencyStop()}
                        >
                          <Stop size={14} weight="fill" aria-hidden="true" />
                          {t('agentControlCenter.killSwitch.confirmStop')}
                        </DsButton>
                        <DsButton
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="[@media(pointer:coarse)]:!min-h-11"
                          disabled={killSwitchBusy}
                          onClick={() => setConfirmStop(false)}
                        >
                          {t('agentControlCenter.killSwitch.cancelConfirm')}
                        </DsButton>
                      </div>
                    </div>
                  ) : (
                    <DsButton
                      type="button"
                      size="sm"
                      className="wb-agent-emergency-stop [@media(pointer:coarse)]:!min-h-11"
                      disabled={killSwitchBusy || killSwitch.tripped}
                      data-testid="wb-agent-emergency-stop"
                      onClick={() => setConfirmStop(true)}
                    >
                      <Stop size={14} weight="fill" aria-hidden="true" />
                      {t('agentControlCenter.killSwitch.emergencyStop')}
                    </DsButton>
                  )}
                  {killSwitchError ? (
                    <p className="wb-agent-control-error" role="alert">
                      {killSwitchError}
                    </p>
                  ) : null}
                </div>

                <AgentCapabilitySummary />
              </CustomScrollArea>

              <div className="wb-agent-control-actions">
                <DsButton
                  size="sm"
                  variant="shell"
                  className="wb-agent-control-open-chat [@media(pointer:coarse)]:!min-h-11"
                  onClick={openChat}
                >
                  <ChatCircleDots size={16} weight="duotone" aria-hidden="true" />
                  {t('agentControlCenter.openChat')}
                </DsButton>
                <DsButton
                  size="icon"
                  variant="ghost"
                  iconOnly
                  className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                  aria-label={t('agentControlCenter.openSettings')}
                  title={t('agentControlCenter.openSettings')}
                  onClick={openControlSettings}
                >
                  <GearSix size={16} weight="duotone" aria-hidden="true" />
                </DsButton>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {!open && (
        <span aria-hidden data-testid="wb-dock-tip-agent-control" className="wb-dock-tip">
          {t('agentControlCenter.tooltip')}
        </span>
      )}
    </div>
  );
}
