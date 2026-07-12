import React from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
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
  ListChecks,
  Robot,
  ShieldCheck,
  Timer,
  TreeStructure,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { setPendingSettingsTab } from '@/utils/pendingSettingsTab';
import { cn } from '@/lib/utils';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { workbenchBus } from '../core/workbenchBus';
import { useLiquidGlassLens } from '../core/liquidGlassLens';

import './AgentControlCenter.css';

export const AGENT_CONTROL_DOCK_ID = '__agent_control__';
export const AGENT_CONTROL_SETTING_KEY = 'desktop.workbenchAgentControl';
export const AGENT_CONTROL_DISCOVERY_SEEN_KEY = 'workbench.agentControl.discoverySeen.v1';

export type AgentControlMode = 'off' | 'background' | 'follow';

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
  {
    id: 'organize',
    icon: FileText,
    titleFallback: '整理内容',
    actionsFallback: '定位并编辑笔记、导图与待办',
  },
  {
    id: 'study',
    icon: Books,
    titleFallback: '推进学习',
    actionsFallback: '切换题目、复习闪卡、管理专注计时',
  },
  {
    id: 'browse',
    icon: Globe,
    titleFallback: '查找资料',
    actionsFallback: '检索资源、切换目录与导航网页',
  },
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
            {t('agentControlCenter.capabilitiesTitle', '能做什么')}
          </h3>
          {variant === 'popover' && (
            <span>{t('agentControlCenter.appCount', '8 个应用')}</span>
          )}
        </div>
        {variant === 'popover' && (
          <NotionButton
            type="button"
            variant="ghost"
            size="sm"
            className="wb-agent-capabilities-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <span>
              {expanded
                ? t('agentControlCenter.collapseCapabilities', '收起')
                : t('agentControlCenter.expandCapabilities', '全部能力')}
            </span>
            <CaretDown size={13} weight="bold" aria-hidden="true" />
          </NotionButton>
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
                    {t(`agentControlCenter.groups.${group.id}.title`, group.titleFallback)}
                  </span>
                  <small>
                    {t(`agentControlCenter.groups.${group.id}.actions`, group.actionsFallback)}
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
            ? t(
                'agentControlCenter.safetyCompact',
                '只执行已注册操作；不会代答、提交或评分，破坏性操作会先确认。',
              )
            : t(
                'agentControlCenter.safety',
                '只使用应用注册的语义操作；不会替你答题、提交考试或给闪卡评分。破坏性操作会在执行前确认。',
              )}
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

    return () => {
      cancelled = true;
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
    setPendingSettingsTab('general');
    workbenchBus.launch({ typeId: 'settings', reason: 'dock' });
    window.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab: 'general' } }));
  }, [handleOpenChange]);

  const statusLabel = t(`settings.agentControl.${mode}`);
  const triggerLabel = t('agentControlCenter.triggerLabel', {
    status: statusLabel,
    defaultValue: `AI 桌面操控，当前：${statusLabel}`,
  });

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
              <NotionButton
                ref={buttonRef}
                type="button"
                data-type-id={AGENT_CONTROL_DOCK_ID}
                data-testid="wb-dock-agent-control-button"
                data-mode={mode}
                data-unseen={!seen || undefined}
                className="wb-dock-item wb-agent-control-trigger group relative flex h-11 w-11 items-center justify-center rounded-xl outline-none"
                aria-label={triggerLabel}
                tabIndex={tabIndex}
                onFocus={onFocus}
                variant="ghost"
                size="icon"
                iconOnly
              >
                <span
                  aria-hidden="true"
                  className="wb-dock-item-icon pointer-events-none flex h-full w-full items-center justify-center"
                >
                  <Robot className="wb-agent-control-dock-glyph" size={27} weight="duotone" />
                </span>
                <span className="wb-agent-control-status-dot" data-mode={mode} aria-hidden="true" />
                {!seen && <span className="wb-agent-control-new-dot" aria-hidden="true" />}
              </NotionButton>
            </PopoverTrigger>

            <PopoverContent
              ref={popoverRef}
              side="top"
              align="end"
              sideOffset={32}
              collisionPadding={12}
              aria-label={t('agentControlCenter.title', 'AI 桌面操控')}
              className="wb-agent-control-popover wb-glass wb-glass-highlight wb-glass-lens"
            >
              <div className="wb-agent-control-scroll">
                <div className="wb-agent-control-header">
                  <div className="wb-agent-control-identity">
                    <span className="wb-agent-control-mark" data-mode={mode} aria-hidden="true">
                      <Robot size={20} weight="duotone" />
                      <i />
                    </span>
                    <div>
                      <h2>{t('agentControlCenter.title', 'AI 桌面操控')}</h2>
                      <p>
                        {t(
                          'agentControlCenter.description',
                          '让 Chat 在学习应用中定位内容并执行已授权操作。',
                        )}
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
                    <span>{t('agentControlCenter.modeLabel', '运行方式')}</span>
                    <SegmentedControl
                      ariaLabel={t('settings.agentControl.title', 'AI 助手操控')}
                      value={mode}
                      onValueChange={(next) => void changeMode(next as AgentControlMode)}
                      size="compact"
                      className={cn('wb-agent-control-segmented', loading && 'opacity-50')}
                      options={([
                        { value: 'off', label: t('settings.agentControl.off', '关闭') },
                        { value: 'background', label: t('settings.agentControl.background', '后台') },
                        { value: 'follow', label: t('settings.agentControl.follow', '跟随') },
                      ] as const).map((option) => ({ ...option, disabled: loading }))}
                    />
                  </div>
                  <p className="wb-agent-control-mode-description">
                    {t(`agentControlCenter.modeDescriptions.${mode}`, {
                      defaultValue: t(`settings.agentControl.${mode}Desc`),
                    })}
                  </p>
                  {saveError && (
                    <p className="wb-agent-control-error" role="alert">
                      {t('agentControlCenter.saveFailed', '未能保存操控方式，请重试。')}
                    </p>
                  )}
                </div>

                <AgentCapabilitySummary />
              </div>

              <div className="wb-agent-control-actions">
                <NotionButton
                  size="sm"
                  variant="shell"
                  className="wb-agent-control-open-chat"
                  onClick={openChat}
                >
                  <ChatCircleDots size={16} weight="duotone" aria-hidden="true" />
                  {t('agentControlCenter.openChat', '打开 Chat')}
                </NotionButton>
                <NotionButton
                  size="icon"
                  variant="ghost"
                  iconOnly
                  aria-label={t('agentControlCenter.openSettings', '操控设置')}
                  title={t('agentControlCenter.openSettings', '操控设置')}
                  onClick={openControlSettings}
                >
                  <GearSix size={16} weight="duotone" aria-hidden="true" />
                </NotionButton>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {!open && (
        <span aria-hidden data-testid="wb-dock-tip-agent-control" className="wb-dock-tip">
          {t('agentControlCenter.tooltip', 'AI 桌面操控')}
        </span>
      )}
    </div>
  );
}
