// RUST-FIX(RF-W35-consent-required-dialog): Rust 版安装渠道插件没有按 ID/版本/权限逐条确认的同意账本弹窗。
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { DsButton } from '@/components/ui/DsButton';
import {
  DsDialog,
  DsDialogBody,
  DsDialogDescription,
  DsDialogFooter,
  DsDialogHeader,
  DsDialogTitle,
} from '@/components/ui/DsDialog';
import { Badge } from '@/components/ui/shad/Badge';
import { SettingsGroup, settingsQuietInteractiveRowClassName } from '@/components/settings';
import { cn } from '@/lib/utils';

import type { PluginConsentSubject } from './types';

export interface ConsentDialogProps {
  /** Host 返回 `CONSENT_REQUIRED` 时给的主体；null 时弹窗关闭。 */
  subject: PluginConsentSubject | null;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * `CONSENT_REQUIRED` 权限同意弹窗（W32/W01）。
 *
 * 弹窗只展示 Host 返回的 ID / 版本 / 权限原文，确认时把同一主体原样交回；
 * 不在本地补权限、不做版本区间匹配，也不把“已同意”当成“物理隔离”。
 */
export function ConsentDialog({ subject, busy = false, error, onConfirm, onCancel }: ConsentDialogProps) {
  const { t } = useTranslation('plugin_manager');
  const titleId = useId();
  const permissions = subject?.permissions ?? [];

  return (
    <DsDialog
      open={subject !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
      closeOnOverlay={!busy}
      showClose={!busy}
      maxWidth="max-w-xl"
      aria-labelledby={titleId}
    >
      {subject ? (
        <>
          <DsDialogHeader>
            <DsDialogTitle id={titleId}>
              {t('consent.title')}
            </DsDialogTitle>
            <DsDialogDescription>
              {t('consent.description', { id: subject.id, version: subject.version })}
            </DsDialogDescription>
          </DsDialogHeader>
          <DsDialogBody className="space-y-4 py-4">
            <dl className="grid min-w-0 grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t('consent.id')}</dt>
              <dd className="min-w-0">
                <code data-testid="plugin-consent-id" className="break-all font-mono text-xs">
                  {subject.id}
                </code>
              </dd>
              <dt className="text-muted-foreground">{t('consent.version')}</dt>
              <dd>
                <code data-testid="plugin-consent-version" className="font-mono text-xs">
                  {subject.version}
                </code>
              </dd>
            </dl>

            <SettingsGroup title={t('consent.permissions')}>
              {permissions.length ? (
                <ul className="space-y-px" data-testid="plugin-consent-permissions">
                  {permissions.map((permission) => (
                    <li
                      key={permission}
                      data-permission={permission}
                      className={cn('flex min-w-0 flex-wrap items-center gap-2 px-1 py-2.5', settingsQuietInteractiveRowClassName)}
                    >
                      <code className="min-w-0 break-all font-mono text-xs">{permission}</code>
                      {permission.startsWith('service:') ? (
                        <Badge variant="outline" className="shrink-0">
                          {t('consent.service')}
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('consent.noPermissions')}</p>
              )}
            </SettingsGroup>

            <p className="text-xs leading-relaxed text-muted-foreground">{t('consent.note')}</p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DsDialogBody>
          <DsDialogFooter>
            <DsButton variant="outline" size="sm" className="[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onCancel} disabled={busy}>
              {t('consent.cancel')}
            </DsButton>
            <DsButton size="sm" className="[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onConfirm} disabled={busy}>
              {busy ? t('consent.working') : t('consent.confirm')}
            </DsButton>
          </DsDialogFooter>
        </>
      ) : null}
    </DsDialog>
  );
}
