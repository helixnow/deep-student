// RUST-FIX(RF-P4-plugin-workshop-ui): managed creations expose reversible lifecycle actions.
import React from 'react';
import { SettingSection, SettingsGroup, SettingRow } from '@/components/settings';
import { DsButton } from '@/components/ui/DsButton';
import { Badge } from '@/components/ui/shad/Badge';
import { actionLabels, phaseLabels } from './copy';
import { workshopActions, type WorkshopAction, type WorkshopItem } from './types';

export interface WorkshopCreationsProps {
  items: WorkshopItem[];
  loading?: boolean;
  busyId?: string;
  error?: string;
  onAction: (action: WorkshopAction, item: WorkshopItem) => void;
  onModify: (item: WorkshopItem) => void;
}

export function WorkshopCreations({ items, loading, busyId, error, onAction, onModify }: WorkshopCreationsProps) {
  return <SettingSection title="我的创作" description="试用会实际运行插件；撤销会卸载插件并保留托管文件，恢复会复查托管副本后重新安装，不再调用模型。">
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    {loading && <p role="status" className="text-sm text-muted-foreground">正在读取创作…</p>}
    {!loading && !items.length && <p className="text-sm text-muted-foreground">还没有创作，点击“用 AI 创作插件”开始。</p>}
    {items.length > 0 && <SettingsGroup title="托管作品">
      {items.map(item => <SettingRow key={item.id} title={item.name} description={`${item.version}${item.description ? ` · ${item.description}` : ''}`}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge variant="secondary">{phaseLabels[item.phase]}</Badge>
          {workshopActions(item.phase).filter(action => action !== 'confirm').map(action => <DsButton key={action} variant="outline" size="sm" disabled={busyId === item.id} onClick={() => onAction(action, item)}>{actionLabels[action]}</DsButton>)}
          {['installed', 'disabled', 'undone', 'failed'].includes(item.phase) && <DsButton variant="ghost" size="sm" disabled={busyId === item.id} onClick={() => onModify(item)}>让 AI 修改</DsButton>}
        </div>
      </SettingRow>)}
    </SettingsGroup>}
  </SettingSection>;
}
