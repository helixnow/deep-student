/**
 * DataPurgePlugin - 数据清理调试插件
 *
 * 提供清空所有应用数据的功能，供开发者调试使用。
 * 危险操作，需二次确认。
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash, CircleNotch, Warning } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DataGovernanceApi } from '@/api/dataGovernance';
import type { DebugPanelPluginProps } from '../DebugPanelHost';

const DataPurgePlugin: React.FC<DebugPanelPluginProps> = ({ isActive }) => {
  const { t } = useTranslation(['data', 'common']);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [isPurgeRunning, setIsPurgeRunning] = useState(false);

  const handlePurgeAllData = useCallback(async () => {
    if (isPurgeRunning) return;
    setIsPurgeRunning(true);
    try {
      await DataGovernanceApi.purgeAllData();
      showGlobalNotification(
        'info',
        t('data:governance.purge_initiated'),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      showGlobalNotification(
        'error',
        message,
        t('data:governance.purge_failed'),
      );
      setIsPurgeRunning(false);
    }
  }, [isPurgeRunning, t]);

  if (!isActive) return null;

  return (
    <div className="p-3 space-y-3">
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3">
        <div className="flex items-center gap-2 text-destructive font-medium">
          <Warning size={16} />
          {t('data:governance.danger_zone')}
        </div>
        <p className="text-sm text-muted-foreground">
          {t('data:governance.purge_all_data_desc')}
        </p>
        <NotionButton
          variant="danger"
          size="sm"
          onClick={() => setShowConfirmDialog(true)}
          disabled={isPurgeRunning}
        >
          {isPurgeRunning ? (
            <CircleNotch className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Trash className="h-4 w-4 mr-2" />
          )}
          {t('data:governance.purge_all_data_button')}
        </NotionButton>
      </div>

      <NotionAlertDialog
        open={showConfirmDialog}
        onOpenChange={(open) => { if (!open) setShowConfirmDialog(false); }}
        title={t('data:governance.purge_confirm_title')}
        description={t('data:governance.purge_confirm_desc')}
        confirmText={t('data:governance.purge_confirm_button')}
        cancelText={t('common:actions.cancel')}
        confirmVariant="danger"
        onConfirm={handlePurgeAllData}
        loading={isPurgeRunning}
        disabled={isPurgeRunning}
      />
    </div>
  );
};

export default DataPurgePlugin;
