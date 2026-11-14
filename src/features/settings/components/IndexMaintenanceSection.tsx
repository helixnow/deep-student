/**
 * 索引维护组件
 * 
 * 从 Settings.tsx 拆分：Lance 向量表优化
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, Lightning, Chat, Question, FolderOpen } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Switch } from '@/components/ui/shad/Switch';
import { TauriAPI } from '@/utils/tauriApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { GroupTitle } from './settingsTabPrimitives';

// Lance 向量表优化面板
export const LanceOptimizationPanel: React.FC = () => {
  const { t } = useTranslation(['settings', 'common']);
  const [optimizing, setOptimizing] = React.useState<{ [key: string]: boolean }>({});
  const [olderThanDays, setOlderThanDays] = React.useState<string>('7');
  const [deleteUnverified, setDeleteUnverified] = React.useState(false);
  const [showInfo, setShowInfo] = React.useState(false);

  const parseSettingBoolean = React.useCallback((value?: string | null) => {
    if (!value) {
      return false;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }
    if (
      trimmed === '1' ||
      trimmed.toLowerCase() === 'true' ||
      trimmed.toLowerCase() === 'yes' ||
      trimmed.toLowerCase() === 'on'
    ) {
      return true;
    }
    if (
      trimmed === '0' ||
      trimmed.toLowerCase() === 'false' ||
      trimmed.toLowerCase() === 'no' ||
      trimmed.toLowerCase() === 'off'
    ) {
      return false;
    }
    return false;
  }, []);

  const optimizeTable = async (tableType: 'chat' | 'vfs') => {
    try {
      setOptimizing(prev => ({ ...prev, [tableType]: true }));
      const parsed = parseInt(olderThanDays);
      const days = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      // 两条命令的契约参数不同：vfs_optimize_lance 只接受 modality（缺省即全部模态）。
      if (tableType === 'chat') {
        await TauriAPI.invoke('optimize_chat_embeddings_table', {
          olderThanDays: days,
          deleteUnverified,
          force: true,
        });
      } else {
        await TauriAPI.invoke('vfs_optimize_lance', {});
      }
      showGlobalNotification('success', t('lance_optimization.optimize_success'));
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('lance_optimization.optimize_failed', { error: errorMessage }));
    } finally {
      setOptimizing(prev => ({ ...prev, [tableType]: false }));
    }
  };

  const optimizeAll = async () => {
    for (const table of ['chat', 'vfs'] as const) {
      await optimizeTable(table);
    }
  };

  const handleToggleDeleteUnverified = async (checked: boolean) => {
    try {
      await TauriAPI.saveSetting('lance.optimize.delete_unverified', checked ? 'true' : 'false');
      setDeleteUnverified(checked);
      showGlobalNotification('success', t('common:security_options_saved'));
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', `${t('common:messages.error.save_failed')}: ${errorMessage}`);
      setDeleteUnverified(!checked);
    }
  };

  React.useEffect(() => {
    TauriAPI.getSetting('lance.optimize.delete_unverified')
      .then(value => setDeleteUnverified(parseSettingBoolean(value)))
      .catch(() => setDeleteUnverified(false));
  }, [parseSettingBoolean]);

  return (
    <section className="min-w-0">
      {/* 标题区 */}
      <GroupTitle
        title={t('lance_optimization.title')}
        description={t('lance_optimization.description')}
        actions={
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => setShowInfo(!showInfo)}
            aria-label={t('lance_optimization.title')}
            className="[@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!min-w-11"
          >
            <Question size={14} />
          </DsButton>
        }
      />

      <div className="space-y-4">
        {/* 信息面板 */}
        {showInfo && (
          <div className="rounded-2xl bg-muted p-4 text-xs text-muted-foreground space-y-2">
            <p className="font-medium text-sm text-foreground">{t('lance_optimization.info.what')}</p>
            <p><strong>{t('lance_optimization.info.why')}</strong> {t('lance_optimization.info.why_answer')}</p>
            <p><strong>{t('lance_optimization.info.when')}</strong> {t('lance_optimization.info.when_answer')}</p>
          </div>
        )}

        {/* 参数配置与操作 */}
        <div className="rounded-2xl bg-muted p-4 space-y-4">
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium mb-1.5 text-foreground">
                {t('lance_optimization.older_than_days')}
              </label>
              <Input
                type="number"
                min={1}
                max={365}
                value={olderThanDays}
                onChange={(e) => setOlderThanDays(e.target.value)}
                className="w-full"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('lance_optimization.older_than_days_hint')}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">
                  {t('lance_optimization.delete_unverified')}
                </span>
                <Switch
                  checked={deleteUnverified}
                  onCheckedChange={handleToggleDeleteUnverified}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('lance_optimization.delete_unverified_hint')}
              </p>
            </div>
          </div>

          {/* 优化按钮组 */}
          <div className="grid grid-cols-2 gap-3 pt-2">
            <DsButton
              variant="outline"
              disabled={optimizing.chat}
              onClick={() => optimizeTable('chat')}
              className="flex flex-col items-center gap-1 h-auto py-3 [@media(pointer:coarse)]:!min-h-11"
            >
              {optimizing.chat ? (
                <CircleNotch size={16} className="animate-spin" />
              ) : (
                <Chat size={16} />
              )}
              <span className="text-xs">{t('lance_optimization.chat_table')}</span>
            </DsButton>

            <DsButton
              variant="outline"
              disabled={optimizing.vfs}
              onClick={() => optimizeTable('vfs')}
              className="flex flex-col items-center gap-1 h-auto py-3 [@media(pointer:coarse)]:!min-h-11"
            >
              {optimizing.vfs ? (
                <CircleNotch size={16} className="animate-spin" />
              ) : (
                <FolderOpen size={16} />
              )}
              <span className="text-xs">{t('lance_optimization.vfs_table')}</span>
            </DsButton>
          </div>

          {/* 一键优化所有表 */}
          <DsButton
            variant="outline"
            disabled={Object.values(optimizing).some(v => v)}
            onClick={optimizeAll}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {Object.values(optimizing).some(v => v) ? (
              <>
                <CircleNotch size={16} className="mr-2 animate-spin" />
                {t('lance_optimization.optimizing')}
              </>
            ) : (
              <>
                <Lightning size={16} className="mr-2" />
                {t('lance_optimization.optimize_all')}
              </>
            )}
          </DsButton>
        </div>
      </div>
    </section>
  );
};
