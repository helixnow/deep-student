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
import { SettingsGroup, settingsQuietInteractiveRowClassName } from '@/components/settings';
import { cn } from '@/lib/utils';

import { permissionLines } from './permissions';
import type { ManagedPlugin, PluginConsentSubject } from './types';

export interface ConsentDialogProps {
  /** Host 返回 `CONSENT_REQUIRED` 时给的主体；null 时弹窗关闭。 */
  subject: PluginConsentSubject | null;
  /** 这个插件声明的智能体工具：`agent:tools` 按工具标题逐条说明。 */
  agentTools?: ManagedPlugin['agentTools'];
  /** 给人看的名字（缺省用 ID）。 */
  name?: string;
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
export function ConsentDialog({ subject, agentTools, name, busy = false, error, onConfirm, onCancel }: ConsentDialogProps) {
  const { t } = useTranslation('plugin_manager');
  const titleId = useId();
  const permissions = subject?.permissions ?? [];
  // 先说人话（与工坊确认卡同一套用词），权限原文小字留在下面：同意写进账本的是这些原文。
  const lines = permissionLines(permissions, agentTools, t);

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
              {t('consent.title', { name: name ?? subject.id })}
            </DsDialogTitle>
            <DsDialogDescription>
              {t('consent.description')}
            </DsDialogDescription>
          </DsDialogHeader>
          <DsDialogBody className="space-y-4 py-4">
            {/* ID 与版本是核对用的事实，不是用户要做的决定：收进技术信息。同意账本照旧绑定这两项。 */}
            <details className="text-xs text-muted-foreground" data-testid="plugin-consent-technical">
            <summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manager.technical')}</summary>
            <dl className="mt-2 grid min-w-0 grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
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
            </details>

            <SettingsGroup title={t('consent.permissions')}>
              {permissions.length ? (
                <ul className="space-y-px" data-testid="plugin-consent-permissions">
                  {lines.map((line, index) => (
                    <li
                      key={`${line.raw}:${index}`}
                      data-permission={line.raw}
                      className={cn('min-w-0 px-1 py-2', settingsQuietInteractiveRowClassName)}
                    >
                      <span className="block text-sm text-foreground/90 [overflow-wrap:anywhere]">{line.text}</span>
                      {line.text !== line.raw ? <code className="mt-0.5 block break-all font-mono text-2xs text-muted-foreground/70">{line.raw}</code> : null}
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
