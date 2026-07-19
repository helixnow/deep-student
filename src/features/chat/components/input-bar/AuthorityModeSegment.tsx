/**
 * Ask / Plan / Craft segmented control.
 * Persistence is owned by `onModeChange` (store `setAuthorityMode` → chat_v2_set_authority_mode).
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';

export type AuthorityMode = 'ask' | 'plan' | 'craft';
export type PermissionPreset = 'cautious' | 'relaxed';

export interface AuthorityModeSegmentProps {
  sessionId: string;
  mode: AuthorityMode;
  /** Persist + update store; may return a Promise (awaited for busy state). */
  onModeChange: (mode: AuthorityMode) => void | Promise<void>;
  permissionPreset?: PermissionPreset;
  onPermissionPresetChange?: (preset: PermissionPreset) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  /** Show Ask-blocked CTA to switch into Plan */
  showSwitchToPlanHint?: boolean;
}

const MODES: AuthorityMode[] = ['ask', 'plan', 'craft'];

export const AuthorityModeSegment: React.FC<AuthorityModeSegmentProps> = ({
  sessionId,
  mode,
  onModeChange,
  permissionPreset = 'cautious',
  onPermissionPresetChange = () => {},
  disabled,
  className,
  showSwitchToPlanHint,
}) => {
  const { t } = useTranslation('chatV2');
  const [pending, setPending] = useState(false);

  const setMode = useCallback(
    async (next: AuthorityMode) => {
      if (!sessionId || next === mode || pending || disabled) return;
      setPending(true);
      try {
        await Promise.resolve(onModeChange(next));
      } catch (error) {
        console.error('[AuthorityModeSegment] Failed to set mode:', error);
      } finally {
        setPending(false);
      }
    },
    [disabled, mode, onModeChange, pending, sessionId],
  );

  const setPreset = useCallback(async (next: PermissionPreset) => {
    if (!sessionId || next === permissionPreset || pending || disabled) return;
    setPending(true);
    try {
      await Promise.resolve(onPermissionPresetChange(next));
    } catch (error) {
      console.error('[AuthorityModeSegment] Failed to set permission preset:', error);
    } finally {
      setPending(false);
    }
  }, [disabled, onPermissionPresetChange, pending, permissionPreset, sessionId]);

  const label = (m: AuthorityMode) => {
    switch (m) {
      case 'ask':
        return t('authority.modes.ask', '问一问');
      case 'plan':
        return t('authority.modes.plan', '想一想');
      case 'craft':
        return t('authority.modes.craft', '做一做');
    }
  };

  const hint = (m: AuthorityMode) => {
    switch (m) {
      case 'ask':
        return t('authority.hints.ask', '只读：写工具会被拒绝');
      case 'plan':
        return t('authority.hints.plan', '写操作先确认计划再执行');
      case 'craft':
        return t('authority.hints.craft', '按工具审批策略直接执行');
    }
  };

  return (
    <div className={cn('flex flex-col items-end gap-1', className)}>
      <div
        className="inline-flex rounded-md border border-border/60 bg-muted/30 p-0.5"
        role="group"
        aria-label={t('authority.segmentLabel', '会话权限档位')}
        aria-busy={pending || undefined}
        data-testid="authority-mode-segment"
      >
        {MODES.map((m) => (
          <CommonTooltip key={m} content={hint(m)}>
            <button
              type="button"
              disabled={disabled || pending || !sessionId}
              onClick={() => void setMode(m)}
              className={cn(
                'px-2 py-1 text-[11px] rounded-[5px] transition-colors',
                mode === m
                  ? 'bg-background text-foreground shadow-sm font-medium'
                  : 'text-muted-foreground hover:text-foreground',
                (disabled || pending) && 'opacity-60 cursor-not-allowed',
              )}
              aria-pressed={mode === m}
              title={hint(m)}
              data-testid={`authority-mode-${m}`}
            >
              {label(m)}
            </button>
          </CommonTooltip>
        ))}
      </div>
      <div
        className="inline-flex rounded-md border border-border/60 bg-muted/20 p-0.5"
        role="group"
        aria-label={t('authority.permissionPreset.label', '审批预设')}
        data-testid="permission-preset-segment"
      >
        {(['cautious', 'relaxed'] as PermissionPreset[]).map((preset) => {
          const active = permissionPreset === preset;
          const title = t(`authority.permissionPreset.hints.${preset}`);
          return (
            <CommonTooltip key={preset} content={title}>
              <button
                type="button"
                disabled={disabled || pending || !sessionId}
                onClick={() => void setPreset(preset)}
                className={cn(
                  'rounded-[5px] px-2 py-0.5 text-[10px] transition-colors',
                  active
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                aria-pressed={active}
                title={title}
                data-testid={`permission-preset-${preset}`}
              >
                {t(`authority.permissionPreset.modes.${preset}`)}
              </button>
            </CommonTooltip>
          );
        })}
      </div>
      {showSwitchToPlanHint && mode === 'ask' && (
        <button
          type="button"
          className="text-[11px] text-amber-700 dark:text-amber-400 underline-offset-2 hover:underline text-left"
          onClick={() => void setMode('plan')}
          disabled={disabled || pending}
          aria-label={t('authority.switchToPlan', '切换到想一想')}
        >
          {t('authority.switchToPlan', '切换到想一想')}
        </button>
      )}
    </div>
  );
};

export default AuthorityModeSegment;
