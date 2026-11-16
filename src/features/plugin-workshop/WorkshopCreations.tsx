// RUST-FIX(RF-P4-plugin-workshop-ui): managed creations expose reversible lifecycle actions.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { SettingRow } from '@/components/settings';
import { DsButton } from '@/components/ui/DsButton';
import { Badge } from '@/components/ui/shad/Badge';
import { WorkshopErrorNotice } from './WorkshopConfirmationCard';
import type { WorkshopAction, WorkshopItem } from './types';

export interface WorkshopCreationsProps {
  items: WorkshopItem[];
  loading?: boolean;
  busyId?: string;
  error?: string;
  onAction: (action: WorkshopAction, item: WorkshopItem) => void;
  onModify: (item: WorkshopItem) => void;
  /** Off when the container already shows the explanation above other content. */
  showDescription?: boolean;
  /** Hide the 「还没有作品」 line (the container shows other works). */
  emptyHidden?: boolean;
}

/** Row actions in the shared vocabulary: 卸载 / 恢复 / 回到上一版 / 停下 / 让 AI 改. */
function rowActions(item: WorkshopItem): { action: WorkshopAction; key: string }[] {
  switch (item.phase) {
    case 'generating': case 'validating': return [{ action: 'cancel', key: 'stop' }];
    case 'installed': case 'disabled': return [{ action: 'undo', key: 'uninstall' }];
    case 'undone': return [{ action: 'restore', key: 'restore' }];
    case 'failed': return item.previousVersion && item.previousVersion !== item.version ? [{ action: 'restore', key: 'restorePrevious' }] : [];
    default: return [];
  }
}

export function WorkshopCreations({ items, loading, busyId, error, onAction, onModify, showDescription = true, emptyHidden = false }: WorkshopCreationsProps) {
  const { t } = useTranslation('plugin_manager');
  // Mounted under the manager's 「工坊创作记录」 toggle, which is already the title: only the explanation and rows here.
  return <div className="min-w-0 space-y-2" data-testid="workshop-creations">
    {showDescription ? <p className="px-1 text-xs leading-relaxed text-muted-foreground">{t('workshop.creationsDescription')}</p> : null}
    {error && <WorkshopErrorNotice raw={error} name="" />}
    {loading && <p role="status" className="text-sm text-muted-foreground">{t('workshop.creationsLoading')}</p>}
    {!loading && !items.length && !emptyHidden && <p className="text-sm text-muted-foreground">{t('workshop.creationsEmpty')}</p>}
    {items.length > 0 && <div className="rounded-2xl bg-muted px-2 py-1 sm:px-3">
      {items.map(item => <SettingRow key={item.id} title={item.name}
        description={`${item.version ? `v${item.version}` : ''}${item.version && item.description ? ' · ' : ''}${item.description ?? ''}`}>
        <div className="flex flex-wrap items-center justify-end gap-2" data-testid="workshop-creation" data-phase={item.phase}>
          <Badge variant="secondary">{t(`workshop.phase.${item.phase}`)}</Badge>
          {rowActions(item).map(({ action, key }) => <DsButton key={key} variant="outline" size="sm" disabled={busyId === item.id} onClick={() => onAction(action, item)}>{t(`workshop.actions.${key}`)}</DsButton>)}
          {['installed', 'disabled', 'undone', 'failed'].includes(item.phase) && <DsButton variant="ghost" size="sm" disabled={busyId === item.id} onClick={() => onModify(item)}>{t('workshop.actions.modify')}</DsButton>}
        </div>
      </SettingRow>)}
    </div>}
  </div>;
}
