import type { TFunction } from 'i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { openArchivedSessionsSettings } from '@/utils/pendingSettingsTab';

const archiveToastKey = (key: string, namespace?: string): string =>
  namespace ? `${namespace}:page.${key}` : `page.${key}`;

export function showArchiveSessionToast(t: TFunction, namespace?: string): void {
  showGlobalNotification(
    'success',
    t(archiveToastKey('archiveSessionToastMessage', namespace), '已归档。查看已归档的会话：'),
    undefined,
    {
      action: {
        label: t(archiveToastKey('archiveSessionToastSettingsAction', namespace), '设置'),
        onClick: openArchivedSessionsSettings,
      },
      borderTone: 'neutral',
    }
  );
}
