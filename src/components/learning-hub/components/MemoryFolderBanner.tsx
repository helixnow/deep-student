/**
 * MemoryFolderBanner - 记忆文件夹专属工具栏
 *
 * ★ 记忆系统改造：当 Finder 导航到记忆根文件夹（或其子文件夹）时显示，
 * 提供记忆系统独有的功能入口（自动提取频率、画像、审计日志、批量导入、导出）。
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  History,
  Download,
  ListPlus,
  Loader2,
  Plus,
  X,
  GitBranch,
  List,
} from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { MemoryIcon } from '../icons/ResourceIcons';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  getMemoryConfig,
  getMemoryProfile,
  getMemoryAuditLogs,
  setMemoryAutoExtractFrequency,
  exportAllMemories,
  writeMemoryBatch,
  writeMemorySmart,
  type AutoExtractFrequency,
  type MemoryConfig,
  type MemoryProfileSection,
  type MemoryAuditLogItem,
  type MemoryTypeValue,
} from '@/api/memoryApi';
import { CustomScrollArea } from '@/components/custom-scroll-area';

const AUDIT_LOG_PAGE_SIZE = 30;

interface MemoryFolderBannerProps {
  className?: string;
  onRefresh?: () => void;
  isTreeView?: boolean;
  onToggleTreeView?: () => void;
}

export const MemoryFolderBanner: React.FC<MemoryFolderBannerProps> = React.memo(({
  className,
  onRefresh,
  isTreeView = false,
  onToggleTreeView,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);

  const [config, setConfig] = useState<MemoryConfig | null>(null);

  // 面板状态
  const [showProfile, setShowProfile] = useState(false);
  const [profileSections, setProfileSections] = useState<MemoryProfileSection[]>([]);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);

  const [showAuditLog, setShowAuditLog] = useState(false);
  const [auditLogs, setAuditLogs] = useState<MemoryAuditLogItem[]>([]);
  const [isLoadingAuditLog, setIsLoadingAuditLog] = useState(false);

  const [showBatchImport, setShowBatchImport] = useState(false);
  const [batchImportText, setBatchImportText] = useState('');
  const [batchImportType, setBatchImportType] = useState<MemoryTypeValue>('study');
  const [isImporting, setIsImporting] = useState(false);

  const [showNewMemory, setShowNewMemory] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newType, setNewType] = useState<MemoryTypeValue>('study');
  const [isCreating, setIsCreating] = useState(false);

  // 加载配置
  useEffect(() => {
    getMemoryConfig().then(setConfig).catch(() => {});
  }, []);

  // 自动提取频率
  const handleFrequencyChange = useCallback(async (freq: AutoExtractFrequency) => {
    if (config?.autoExtractFrequency === freq) return;
    try {
      await setMemoryAutoExtractFrequency(freq);
      const updated = await getMemoryConfig();
      setConfig(updated);
      showGlobalNotification('success', t('memory.frequency_changed', '自动提取频率已更新'));
    } catch {
      showGlobalNotification('error', t('memory.frequency_change_error', '设置失败'));
    }
  }, [config?.autoExtractFrequency, t]);

  // 画像
  const handleToggleProfile = useCallback(async () => {
    if (showProfile) { setShowProfile(false); return; }
    setIsLoadingProfile(true);
    setShowProfile(true);
    setShowAuditLog(false);
    try {
      const sections = await getMemoryProfile();
      setProfileSections(sections);
    } catch {
      setProfileSections([]);
    } finally {
      setIsLoadingProfile(false);
    }
  }, [showProfile]);

  // 审计日志
  const handleToggleAuditLog = useCallback(async () => {
    if (showAuditLog) { setShowAuditLog(false); return; }
    setShowAuditLog(true);
    setShowProfile(false);
    setIsLoadingAuditLog(true);
    try {
      const logs = await getMemoryAuditLogs({ limit: AUDIT_LOG_PAGE_SIZE, offset: 0 });
      setAuditLogs(logs);
    } catch {
      showGlobalNotification('error', t('memory.audit_load_error', '加载操作日志失败'));
    } finally {
      setIsLoadingAuditLog(false);
    }
  }, [showAuditLog, t]);

  // 导出
  const handleExport = useCallback(async () => {
    try {
      const exportData = await exportAllMemories();
      if (exportData.length === 0) {
        showGlobalNotification('warning', t('memory.export_empty', '没有可导出的记忆'));
        return;
      }
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `memories_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showGlobalNotification('success', t('memory.export_success', `已导出 ${exportData.length} 条记忆`));
    } catch {
      showGlobalNotification('error', t('memory.export_error', '导出失败'));
    }
  }, [t]);

  // 批量导入
  const parseBatchItems = useCallback((raw: string) => {
    return raw.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const separators = ['\t', ' | ', '｜', '：', ':'];
      for (const sep of separators) {
        const idx = line.indexOf(sep);
        if (idx > 0) {
          const title = line.slice(0, idx).trim();
          const content = line.slice(idx + sep.length).trim();
          if (title && content) return { title, content };
        }
      }
      return { title: line, content: line };
    });
  }, []);

  const handleBatchImport = useCallback(async () => {
    const items = parseBatchItems(batchImportText);
    if (items.length === 0) {
      showGlobalNotification('error', t('memory.batch_import_empty', '请先粘贴要导入的内容'));
      return;
    }
    setIsImporting(true);
    try {
      const result = await writeMemoryBatch(
        items.map(item => ({ ...item, memoryType: batchImportType })),
        undefined,
        batchImportType,
      );
      showGlobalNotification(
        result.filtered > 0 ? 'warning' : 'success',
        t('memory.batch_import_summary', '已处理 {{total}} 条：新增 {{added}}，更新 {{updated}}，跳过 {{skipped}}，拦截 {{filtered}}', {
          total: result.total, added: result.added, updated: result.updated, skipped: result.skipped, filtered: result.filtered,
        }),
      );
      if (result.added + result.updated > 0) {
        setShowBatchImport(false);
        setBatchImportText('');
        onRefresh?.();
      }
    } catch {
      showGlobalNotification('error', t('memory.batch_import_error', '批量导入失败'));
    } finally {
      setIsImporting(false);
    }
  }, [batchImportText, batchImportType, onRefresh, parseBatchItems, t]);

  // 新建记忆
  const handleCreateMemory = useCallback(async () => {
    if (!newTitle.trim() || !newContent.trim()) {
      showGlobalNotification('error', t('memory.empty_content', '标题和内容不能为空'));
      return;
    }
    setIsCreating(true);
    try {
      const result = await writeMemorySmart(newTitle, newContent, undefined, newType);
      const succeeded = result.event === 'ADD' || result.event === 'UPDATE' || result.event === 'APPEND';
      if (result.event === 'FILTERED') {
        showGlobalNotification('warning', result.reason || t('memory.create_filtered', '内容触发安全拦截'));
      } else if (succeeded) {
        showGlobalNotification('success', t('memory.create_success', '记忆创建成功'));
        setShowNewMemory(false);
        setNewTitle('');
        setNewContent('');
        setNewType('study');
        onRefresh?.();
      } else {
        showGlobalNotification('warning', t('memory.create_already_exists', '该记忆已存在'));
      }
    } catch {
      showGlobalNotification('error', t('memory.create_error', '创建失败'));
    } finally {
      setIsCreating(false);
    }
  }, [newTitle, newContent, newType, onRefresh, t]);

  if (!config) return null;

  return (
    <div className={cn('border-b border-border/40', className)}>
      {/* 工具栏 */}
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <MemoryIcon size={14} className="text-muted-foreground shrink-0" />
        <span className="text-[11px] text-muted-foreground mr-1">{t('memory.auto_extract', '自动提取')}:</span>
        <div className="flex items-center gap-0.5">
          {([
            { value: 'off' as const, label: t('memory.freq_off', '关闭') },
            { value: 'balanced' as const, label: t('memory.freq_balanced', '平衡') },
            { value: 'aggressive' as const, label: t('memory.freq_aggressive', '积极') },
          ]).map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleFrequencyChange(opt.value)}
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] transition-colors',
                config.autoExtractFrequency === opt.value
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <NotionButton variant="ghost" size="icon" iconOnly
          onClick={handleToggleProfile}
          className={cn('!h-6 !w-6', showProfile && 'text-primary bg-primary/10')}
          title={t('memory.profile_title', '系统对我的了解')}
        >
          <MemoryIcon size={13} />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly
          onClick={handleToggleAuditLog}
          className={cn('!h-6 !w-6', showAuditLog && 'text-primary bg-primary/10')}
          title={t('memory.audit_log', '操作日志')}
        >
          <History className="w-3.5 h-3.5" />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly
          onClick={handleExport}
          className="!h-6 !w-6"
          title={t('memory.export', '导出记忆')}
        >
          <Download className="w-3.5 h-3.5" />
        </NotionButton>

        <NotionButton variant="ghost" size="icon" iconOnly
          onClick={onToggleTreeView}
          className={cn('!h-6 !w-6', isTreeView && 'text-primary bg-primary/10')}
          title={isTreeView ? '列表视图' : '树状图预览'}
        >
          {isTreeView ? <List className="w-3.5 h-3.5" /> : <GitBranch className="w-3.5 h-3.5" />}
        </NotionButton>

        <div className="w-px h-4 bg-border/50" />

        <NotionButton variant="ghost" size="sm"
          onClick={() => { setShowBatchImport(!showBatchImport); setShowNewMemory(false); }}
          className={cn('!h-6 !px-1.5 text-[11px]', showBatchImport && 'text-primary bg-primary/10')}
        >
          <ListPlus className="w-3.5 h-3.5" />
          {t('memory.batch_import', '批量导入')}
        </NotionButton>
        <NotionButton variant="ghost" size="sm"
          onClick={() => { setShowNewMemory(!showNewMemory); setShowBatchImport(false); }}
          className={cn('!h-6 !px-1.5 text-[11px] text-primary', showNewMemory && 'bg-primary/10')}
        >
          <Plus className="w-3.5 h-3.5" />
          {t('memory.new', '新建')}
        </NotionButton>
      </div>

      {/* 画像面板 */}
      {showProfile && (
        <div className="border-t border-border/30 px-3 py-2 bg-muted/10">
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">{t('memory.profile_title', '系统对我的了解')}</div>
          {isLoadingProfile ? (
            <div className="flex items-center justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
          ) : profileSections.length === 0 ? (
            <div className="text-[11px] text-muted-foreground/60 py-2">{t('memory.no_profile', '暂无画像数据，系统会在积累足够记忆后生成。')}</div>
          ) : (
            <CustomScrollArea className="max-h-40">
              <div className="space-y-1.5">
                {profileSections.map((section, i) => (
                  <div key={i}>
                    <div className="text-[10px] font-medium text-muted-foreground">{section.category}</div>
                    <div className="text-[11px] text-foreground/80 whitespace-pre-wrap">{section.content}</div>
                  </div>
                ))}
              </div>
            </CustomScrollArea>
          )}
        </div>
      )}

      {/* 审计日志面板 */}
      {showAuditLog && (
        <div className="border-t border-border/30 px-3 py-2 bg-muted/10">
          <div className="text-[11px] font-medium text-muted-foreground mb-1.5">{t('memory.audit_log', '操作日志')}</div>
          {isLoadingAuditLog ? (
            <div className="flex items-center justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
          ) : auditLogs.length === 0 ? (
            <div className="text-[11px] text-muted-foreground/60 py-2">{t('memory.audit_empty', '暂无操作日志')}</div>
          ) : (
            <CustomScrollArea className="max-h-48">
              <div className="space-y-1">
                {auditLogs.map((log, i) => (
                  <div key={i} className="flex items-start gap-2 text-[10px] py-0.5">
                    <span className="text-muted-foreground/50 tabular-nums shrink-0">{new Date(log.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    <span className={cn('shrink-0', log.success ? 'text-emerald-500' : 'text-rose-500')}>{log.success ? '✓' : '✗'}</span>
                    <span className="text-foreground/70 truncate">{log.title || log.event}</span>
                  </div>
                ))}
              </div>
            </CustomScrollArea>
          )}
        </div>
      )}

      {/* 批量导入面板 */}
      {showBatchImport && (
        <div className="border-t border-border/30 px-3 py-2 bg-muted/10 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">{t('memory.batch_import', '批量导入')}</span>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setShowBatchImport(false)} className="!h-5 !w-5"><X className="w-3 h-3" /></NotionButton>
          </div>
          <textarea
            placeholder={t('memory.batch_import_placeholder', '每行一条，格式：标题\\t内容 或 标题：内容')}
            value={batchImportText}
            onChange={(e) => setBatchImportText(e.target.value)}
            rows={4}
            className="w-full px-2 py-1.5 text-[11px] bg-muted/30 border-transparent rounded-md resize-none focus:border-border focus:bg-background focus:outline-none transition-colors"
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">{t('memory.type', '类型')}:</span>
            {(['fact', 'study', 'note'] as const).map(type => (
              <button key={type} onClick={() => setBatchImportType(type)}
                className={cn('px-1.5 py-0.5 rounded text-[10px]', batchImportType === type ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:bg-muted/50')}
              >
                {type === 'fact' ? '事实' : type === 'study' ? '学习' : '笔记'}
              </button>
            ))}
            <div className="flex-1" />
            <NotionButton variant="primary" size="sm" onClick={handleBatchImport} disabled={isImporting || !batchImportText.trim()} className="!h-6 !px-2 text-[11px]">
              {isImporting && <Loader2 className="w-3 h-3 animate-spin" />}
              {t('memory.batch_import_confirm', '开始导入')}
            </NotionButton>
          </div>
        </div>
      )}

      {/* 新建记忆面板 */}
      {showNewMemory && (
        <div className="border-t border-border/30 px-3 py-2 bg-muted/10 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">{t('memory.create_title', '创建新记忆')}</span>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setShowNewMemory(false)} className="!h-5 !w-5"><X className="w-3 h-3" /></NotionButton>
          </div>
          <input
            placeholder={t('memory.title_placeholder', '记忆标题')}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            autoFocus
            className="w-full h-7 px-2 text-[11px] bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
          />
          <textarea
            placeholder={t('memory.content_placeholder_study', '学习内容...')}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            rows={3}
            className="w-full px-2 py-1.5 text-[11px] bg-muted/30 border-transparent rounded-md resize-none focus:border-border focus:bg-background focus:outline-none transition-colors"
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">{t('memory.type', '类型')}:</span>
            {(['fact', 'study', 'note'] as const).map(type => (
              <button key={type} onClick={() => setNewType(type)}
                className={cn('px-1.5 py-0.5 rounded text-[10px]', newType === type ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:bg-muted/50')}
              >
                {type === 'fact' ? '事实' : type === 'study' ? '学习' : '笔记'}
              </button>
            ))}
            <div className="flex-1" />
            <NotionButton variant="primary" size="sm" onClick={handleCreateMemory} disabled={isCreating || !newTitle.trim() || !newContent.trim()} className="!h-6 !px-2 text-[11px]">
              {isCreating && <Loader2 className="w-3 h-3 animate-spin" />}
              {t('common:create', '创建')}
            </NotionButton>
          </div>
        </div>
      )}
    </div>
  );
});

MemoryFolderBanner.displayName = 'MemoryFolderBanner';

export default MemoryFolderBanner;
