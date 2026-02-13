/**
 * 索引维护组件
 * 
 * 从 Settings.tsx 拆分：全局索引维护、Lance 向量表优化
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, FileText, Zap, MessageSquare, Info, ChevronDown, ChevronUp, Database, HelpCircle, BookOpen, Network, InfoIcon } from 'lucide-react';
import { AlertTitle } from '../ui/shad/Alert';
import { NotionButton } from '../ui/NotionButton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/shad/Card';
import { Alert, AlertDescription } from '../ui/shad/Alert';
import { Input } from '../ui/shad/Input';
import { Switch } from '../ui/shad/Switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/shad/Collapsible';
import { TauriAPI } from '../../utils/tauriApi';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';

// 格式化时间
const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// 全局索引维护按钮组（带上限与 loading）
export const GlobalIndexMaintenance: React.FC = () => {
  const { t } = useTranslation('settings');
  const [running, setRunning] = React.useState(false);
  const [statusText, setStatusText] = React.useState('');

  const handleMaintain = async () => {
    setRunning(true);
    try {
      const parts: string[] = [];
      const rebuilt = await TauriAPI.rebuildChatFts();
      parts.push(rebuilt > 0 ? t('settings:global_index.success_rebuild_fts', { count: rebuilt }) : t('settings:global_index.no_missing'));
      const filled = await TauriAPI.backfillUserMessageEmbeddings({});
      parts.push(filled > 0 ? t('settings:global_index.success_backfill', { count: filled }) : t('settings:global_index.no_missing'));
      const summary = parts.join(' / ');
      showGlobalNotification('success', summary);
      setStatusText(`${t('settings:global_index.last_run', { time: formatTime(Date.now()) })} · ${summary}`);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('settings:global_index.failed_maintain', { error: errorMessage }));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/60 px-3 py-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{t('settings:global_index.section_hint')}</span>
        <span className="text-xs text-muted-foreground">{t('settings:global_index.section_desc')}</span>
      </div>
      {statusText && (
        <div className="rounded-md bg-background/60 px-3 py-2 text-xs text-muted-foreground">{statusText}</div>
      )}
      <NotionButton variant="default" disabled={running} onClick={handleMaintain} className="w-full md:w-auto">
        {running ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('settings:global_index.maintaining')}
          </>
        ) : (
          t('settings:global_index.maintain_all')
        )}
      </NotionButton>
    </div>
  );
};

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

  const optimizeTable = async (tableType: string, commandName: string) => {
    try {
      setOptimizing(prev => ({ ...prev, [tableType]: true }));
      const parsed = parseInt(olderThanDays);
      const days = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      await TauriAPI.invoke(commandName, {
        older_than_days: days,
        delete_unverified: deleteUnverified,
        force: true,
      });
      showGlobalNotification('success', t('lance_optimization.optimize_success'));
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      showGlobalNotification('error', t('lance_optimization.optimize_failed', { error: errorMessage }));
    } finally {
      setOptimizing(prev => ({ ...prev, [tableType]: false }));
    }
  };

  const optimizeAll = async () => {
    const tables = [
      { type: 'chat', command: 'optimize_chat_embeddings_table' },
      { type: 'kb', command: 'optimize_kb_embeddings_table' },
      { type: 'kg', command: 'optimize_kg_embeddings_table' },
      { type: 'notes', command: 'optimize_notes_embeddings_table' },
    ];

    for (const table of tables) {
      await optimizeTable(table.type, table.command);
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
    <Card className="p-2 text-left h-full flex flex-col overflow-hidden min-w-0">
      <CardHeader className="p-0 mb-3 text-left w-full">
        <div className="flex flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <CardTitle className="text-base text-left">{t('lance_optimization.title')}</CardTitle>
          </div>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => setShowInfo(!showInfo)}
          >
            <HelpCircle className="h-4 w-4" />
          </NotionButton>
        </div>
        <CardDescription className="mt-1 text-sm text-muted-foreground">
          {t('lance_optimization.description')}
        </CardDescription>
      </CardHeader>

      <CardContent className="p-0 space-y-4 flex-1 flex flex-col">
        {/* 信息面板 */}
        {showInfo && (
          <Alert>
            <InfoIcon className="h-4 w-4" />
            <AlertTitle>{t('lance_optimization.info.what')}</AlertTitle>
            <AlertDescription className="text-xs space-y-2">
              <p><strong>{t('lance_optimization.info.why')}</strong> {t('lance_optimization.info.why_answer')}</p>
              <p><strong>{t('lance_optimization.info.when')}</strong> {t('lance_optimization.info.when_answer')}</p>
            </AlertDescription>
          </Alert>
        )}

        {/* 参数配置 */}
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-foreground">
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
            <p className="mt-1 text-xs text-muted-foreground">
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <NotionButton
            variant="outline"
            disabled={optimizing.chat}
            onClick={() => optimizeTable('chat', 'optimize_chat_embeddings_table')}
            className="flex flex-col items-center gap-1 h-auto py-3"
          >
            {optimizing.chat ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MessageSquare className="h-4 w-4" />
            )}
            <span className="text-xs">{t('lance_optimization.chat_table')}</span>
          </NotionButton>

          <NotionButton
            variant="outline"
            disabled={optimizing.kb}
            onClick={() => optimizeTable('kb', 'optimize_kb_embeddings_table')}
            className="flex flex-col items-center gap-1 h-auto py-3"
          >
            {optimizing.kb ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <BookOpen className="h-4 w-4" />
            )}
            <span className="text-xs">{t('lance_optimization.kb_table')}</span>
          </NotionButton>

          <NotionButton
            variant="outline"
            disabled={optimizing.kg}
            onClick={() => optimizeTable('kg', 'optimize_kg_embeddings_table')}
            className="flex flex-col items-center gap-1 h-auto py-3"
          >
            {optimizing.kg ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Network className="h-4 w-4" />
            )}
            <span className="text-xs">{t('lance_optimization.kg_table')}</span>
          </NotionButton>

          <NotionButton
            variant="outline"
            disabled={optimizing.notes}
            onClick={() => optimizeTable('notes', 'optimize_notes_embeddings_table')}
            className="flex flex-col items-center gap-1 h-auto py-3"
          >
            {optimizing.notes ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
            <span className="text-xs">{t('lance_optimization.notes_table')}</span>
          </NotionButton>
        </div>

        {/* 一键优化所有表 */}
        <NotionButton
          variant="default"
          disabled={Object.values(optimizing).some(v => v)}
          onClick={optimizeAll}
          className="w-full"
        >
          {Object.values(optimizing).some(v => v) ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {t('lance_optimization.optimizing')}
            </>
          ) : (
            <>
              <Zap className="h-4 w-4 mr-2" />
              {t('lance_optimization.optimize_all')}
            </>
          )}
        </NotionButton>
      </CardContent>
    </Card>
  );
};
