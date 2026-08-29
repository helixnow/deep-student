/**
 * MemoryFolderBanner - 记忆文件夹专属工具栏
 *
 * ★ 记忆系统改造：当 Finder 导航到记忆根文件夹（或其子文件夹）时显示，
 * 提供记忆系统独有的功能入口（自动提取频率、画像、审计日志、批量导入、导出）。
 * ★ 2026-07：面板互斥 + disclosure 动效 + 配置加载失败可见可重试 +
 *   审计日志分页加载 + 日期按当前语言格式化 + i18n 补齐
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  ClockCounterClockwise,
  Download,
  ListPlus,
  CircleNotch,
  Plus,
  X,
  GitBranch,
  List,
  CheckCircle,
  XCircle,
  WarningCircle,
  ArrowClockwise,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { MemoryIcon } from '../icons/ResourceIcons';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useDisclosureMotion } from '@/features/chat/hooks/useDisclosureMotion';
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

/** 展开面板互斥管理（画像 / 审计 / 批量导入 / 新建 同时最多一个） */
type ActivePanel = 'profile' | 'audit' | 'import' | 'new' | null;

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
  const { t, i18n } = useTranslation(['learningHub', 'common']);
  const disclosureMotion = useDisclosureMotion();

  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);

  const [activePanel, setActivePanel] = useState<ActivePanel>(null);

  // 画像
  const [profileSections, setProfileSections] = useState<MemoryProfileSection[]>([]);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [profileError, setProfileError] = useState(false);

  // 审计日志
  const [auditLogs, setAuditLogs] = useState<MemoryAuditLogItem[]>([]);
  const [isLoadingAuditLog, setIsLoadingAuditLog] = useState(false);
  const [hasMoreAuditLogs, setHasMoreAuditLogs] = useState(false);

  // 批量导入
  const [batchImportText, setBatchImportText] = useState('');
  const [batchImportType, setBatchImportType] = useState<MemoryTypeValue>('study');
  const [isImporting, setIsImporting] = useState(false);

  // 新建记忆
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newType, setNewType] = useState<MemoryTypeValue>('study');
  const [isCreating, setIsCreating] = useState(false);

  // 频率保存中标记（防连点竞态）
  const [savingFrequency, setSavingFrequency] = useState(false);
  // 导出进行中
  const [isExporting, setIsExporting] = useState(false);

  // 加载配置（卸载后不再 setState；失败可见可重试）
  const loadConfig = useCallback(() => {
    setIsLoadingConfig(true);
    setConfigError(false);
    let cancelled = false;
    getMemoryConfig()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        setConfigError(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('[MemoryFolderBanner] Failed to load config:', error);
        setConfigError(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingConfig(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => loadConfig(), [loadConfig]);

  // 自动提取频率
  const handleFrequencyChange = useCallback(async (freq: AutoExtractFrequency) => {
    if (config?.autoExtractFrequency === freq || savingFrequency) return;
    setSavingFrequency(true);
    try {
      await setMemoryAutoExtractFrequency(freq);
      const updated = await getMemoryConfig();
      setConfig(updated);
      showGlobalNotification('success', t('memory.frequency_changed'));
    } catch {
      showGlobalNotification('error', t('memory.frequency_change_error'));
    } finally {
      setSavingFrequency(false);
    }
  }, [config?.autoExtractFrequency, savingFrequency, t]);

  // 画像
  const handleToggleProfile = useCallback(async () => {
    if (activePanel === 'profile') { setActivePanel(null); return; }
    setIsLoadingProfile(true);
    setProfileError(false);
    setActivePanel('profile');
    try {
      const sections = await getMemoryProfile();
      setProfileSections(sections);
    } catch {
      setProfileSections([]);
      setProfileError(true);
    } finally {
      setIsLoadingProfile(false);
    }
  }, [activePanel]);

  // 审计日志
  const loadAuditLogs = useCallback(async (offset: number) => {
    setIsLoadingAuditLog(true);
    try {
      const logs = await getMemoryAuditLogs({ limit: AUDIT_LOG_PAGE_SIZE, offset });
      setHasMoreAuditLogs(logs.length >= AUDIT_LOG_PAGE_SIZE);
      if (offset === 0) {
        setAuditLogs(logs);
      } else {
        setAuditLogs(prev => {
          const seen = new Set(prev.map(l => l.id));
          return [...prev, ...logs.filter(l => !seen.has(l.id))];
        });
      }
    } catch {
      showGlobalNotification('error', t('memory.audit_load_error'));
    } finally {
      setIsLoadingAuditLog(false);
    }
  }, [t]);

  const handleToggleAuditLog = useCallback(() => {
    if (activePanel === 'audit') { setActivePanel(null); return; }
    setActivePanel('audit');
    loadAuditLogs(0);
  }, [activePanel, loadAuditLogs]);

  // 导出
  const handleExport = useCallback(async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const exportData = await exportAllMemories();
      if (exportData.length === 0) {
        showGlobalNotification('warning', t('memory.export_empty'));
        return;
      }
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `memories_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showGlobalNotification('success', t('memory.export_success', { count: exportData.length }));
    } catch {
      showGlobalNotification('error', t('memory.export_error'));
    } finally {
      setIsExporting(false);
    }
  }, [isExporting, t]);

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
      showGlobalNotification('error', t('memory.batch_import_empty'));
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
        t('memory.batch_import_summary', {
          total: result.total, added: result.added, updated: result.updated, skipped: result.skipped, filtered: result.filtered,
        }),
      );
      if (result.added + result.updated > 0) {
        setActivePanel(null);
        setBatchImportText('');
        onRefresh?.();
      }
    } catch {
      showGlobalNotification('error', t('memory.batch_import_error'));
    } finally {
      setIsImporting(false);
    }
  }, [batchImportText, batchImportType, onRefresh, parseBatchItems, t]);

  // 新建记忆
  const handleCreateMemory = useCallback(async () => {
    if (!newTitle.trim() || !newContent.trim()) {
      showGlobalNotification('error', t('memory.empty_content'));
      return;
    }
    setIsCreating(true);
    try {
      const result = await writeMemorySmart(newTitle, newContent, undefined, newType);
      const succeeded = result.event === 'ADD' || result.event === 'UPDATE' || result.event === 'APPEND';
      if (result.event === 'FILTERED') {
        showGlobalNotification('warning', result.reason || t('memory.create_filtered'));
      } else if (succeeded) {
        showGlobalNotification('success', t('memory.create_success'));
        setActivePanel(null);
        setNewTitle('');
        setNewContent('');
        setNewType('study');
        onRefresh?.();
      } else {
        showGlobalNotification('warning', t('memory.create_already_exists'));
      }
    } catch {
      showGlobalNotification('error', t('memory.create_error'));
    } finally {
      setIsCreating(false);
    }
  }, [newTitle, newContent, newType, onRefresh, t]);

  const formatAuditTime = useCallback((timestamp: string) => {
    return new Date(timestamp).toLocaleString(i18n.language, {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }, [i18n.language]);

  // 加载中不渲染（避免闪烁）；失败渲染可重试的错误条而非整段消失
  if (isLoadingConfig && !config) return null;
  if (configError && !config) {
    return (
      <div className={cn('border-b border-border/40', className)}>
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
          <WarningCircle size={13} className="text-destructive/70 shrink-0" />
          <span>{t('memory.config_load_error')}</span>
          <DsButton variant="ghost" size="sm" onClick={loadConfig} className="!h-5 !px-1.5 text-2xs ml-auto [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-2.5">
            <ArrowClockwise size={11} />
            {t('common:retry')}
          </DsButton>
        </div>
      </div>
    );
  }
  if (!config) return null;

  return (
    <div className={cn('border-b border-border/40', className)}>
      {/* 工具栏（📱 允许换行：窄屏下按钮过多会横向溢出导致部分功能不可达） */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
        <MemoryIcon size={14} className="text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground mr-1">{t('memory.auto_extract')}:</span>
        <div className="flex items-center gap-0.5">
          {([
            { value: 'off' as const, label: t('memory.freq_off'), desc: t('memory.freq_off_desc') },
            { value: 'balanced' as const, label: t('memory.freq_balanced'), desc: t('memory.freq_balanced_desc') },
            { value: 'aggressive' as const, label: t('memory.freq_aggressive'), desc: t('memory.freq_aggressive_desc') },
          ]).map((opt) => (
            <button
              key={opt.value}
              title={opt.desc}
              onClick={() => handleFrequencyChange(opt.value)}
              disabled={savingFrequency}
              className={cn(
                // 触屏放大命中区（桌面保持紧凑）
                'px-1.5 py-0.5 rounded text-2xs transition-colors',
                '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-2.5',
                savingFrequency && 'opacity-60 cursor-wait',
                config.autoExtractFrequency === opt.value
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground'
              )}
            >
              {opt.label}
            </button>
          ))}
          {savingFrequency && <CircleNotch size={11} className="animate-spin text-muted-foreground/60 ml-0.5" />}
        </div>

        <div className="flex-1" />

        <DsButton variant="ghost" size="icon" iconOnly
          onClick={handleToggleProfile}
          className={cn('!h-6 !w-6 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11', activePanel === 'profile' && 'text-primary bg-primary/10')}
          title={t('memory.profile_title')}
        >
          <MemoryIcon size={13} />
        </DsButton>
        <DsButton variant="ghost" size="icon" iconOnly
          onClick={handleToggleAuditLog}
          className={cn('!h-6 !w-6 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11', activePanel === 'audit' && 'text-primary bg-primary/10')}
          title={t('memory.audit_log')}
        >
          <ClockCounterClockwise size={14} />
        </DsButton>
        <DsButton variant="ghost" size="icon" iconOnly
          onClick={handleExport}
          disabled={isExporting}
          className="!h-6 !w-6 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
          title={t('memory.export')}
        >
          {isExporting ? <CircleNotch size={14} className="animate-spin" /> : <Download size={14} />}
        </DsButton>

        <DsButton variant="ghost" size="icon" iconOnly
          onClick={onToggleTreeView}
          className={cn('!h-6 !w-6 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11', isTreeView && 'text-primary bg-primary/10')}
          title={isTreeView ? t('memory.list_view') : t('memory.tree_view')}
        >
          {isTreeView ? <List size={14} /> : <GitBranch size={14} />}
        </DsButton>

        <div className="w-px h-4 bg-border/50" />

        <DsButton variant="ghost" size="sm"
          onClick={() => setActivePanel(activePanel === 'import' ? null : 'import')}
          className={cn('!h-6 !px-1.5 text-xs [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-2.5', activePanel === 'import' && 'text-primary bg-primary/10')}
        >
          <ListPlus size={14} />
          {t('memory.batch_import')}
        </DsButton>
        <DsButton variant="ghost" size="sm"
          onClick={() => setActivePanel(activePanel === 'new' ? null : 'new')}
          className={cn('!h-6 !px-1.5 text-xs text-primary [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-2.5', activePanel === 'new' && 'bg-primary/10')}
        >
          <Plus size={14} />
          {t('memory.new')}
        </DsButton>
      </div>

      <AnimatePresence initial={false} mode="wait">
        {/* 画像面板 */}
        {activePanel === 'profile' && (
          <motion.div key="profile" {...disclosureMotion} className="overflow-hidden">
            <div className="border-t border-border/30 px-3 py-2 bg-muted/10">
              <div className="text-xs font-medium text-muted-foreground mb-1.5">{t('memory.profile_title')}</div>
              {isLoadingProfile ? (
                <div className="flex items-center justify-center py-4"><CircleNotch size={16} className="animate-spin text-muted-foreground" /></div>
              ) : profileError ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                  <WarningCircle size={12} className="text-destructive/70" />
                  <span>{t('memory.profile_load_error')}</span>
                  <DsButton variant="ghost" size="sm" onClick={() => { setActivePanel(null); handleToggleProfile(); }} className="!h-5 !px-1.5 text-2xs [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-2.5">
                    {t('common:retry')}
                  </DsButton>
                </div>
              ) : profileSections.length === 0 ? (
                <div className="text-xs text-muted-foreground/60 py-2">{t('memory.no_profile')}</div>
              ) : (
                <CustomScrollArea className="max-h-40 min-h-0" fullHeight={false}>
                  <div className="space-y-1.5">
                    {profileSections.map((section, i) => (
                      <div key={i}>
                        <div className="text-2xs font-medium text-muted-foreground">{section.category}</div>
                        <div className="text-xs text-foreground/80 whitespace-pre-wrap">{section.content}</div>
                      </div>
                    ))}
                  </div>
                </CustomScrollArea>
              )}
            </div>
          </motion.div>
        )}

        {/* 审计日志面板 */}
        {activePanel === 'audit' && (
          <motion.div key="audit" {...disclosureMotion} className="overflow-hidden">
            <div className="border-t border-border/30 px-3 py-2 bg-muted/10">
              <div className="text-xs font-medium text-muted-foreground mb-1.5">{t('memory.audit_log')}</div>
              {isLoadingAuditLog && auditLogs.length === 0 ? (
                <div className="flex items-center justify-center py-4"><CircleNotch size={16} className="animate-spin text-muted-foreground" /></div>
              ) : auditLogs.length === 0 ? (
                <div className="text-xs text-muted-foreground/60 py-2">{t('memory.audit_empty')}</div>
              ) : (
                <CustomScrollArea className="max-h-48 min-h-0" fullHeight={false}>
                  <div className="space-y-1">
                    {auditLogs.map((log) => (
                      <div key={log.id} className="flex items-start gap-2 text-2xs py-0.5">
                        <span className="text-muted-foreground/50 tabular-nums shrink-0">{formatAuditTime(log.timestamp)}</span>
                        {log.success ? (
                          <CheckCircle size={11} className="text-success shrink-0 mt-px" />
                        ) : (
                          <XCircle size={11} className="text-danger shrink-0 mt-px" />
                        )}
                        <span className="text-foreground/70 truncate">{log.title || log.event}</span>
                      </div>
                    ))}
                    {hasMoreAuditLogs && (
                      <div className="flex justify-center pt-1">
                        <DsButton variant="ghost" size="sm" onClick={() => loadAuditLogs(auditLogs.length)} disabled={isLoadingAuditLog} className="!h-5 !px-2 text-2xs text-muted-foreground [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-3">
                          {isLoadingAuditLog ? <CircleNotch size={10} className="animate-spin" /> : null}
                          {t('memory.audit_load_more')}
                        </DsButton>
                      </div>
                    )}
                  </div>
                </CustomScrollArea>
              )}
            </div>
          </motion.div>
        )}

        {/* 批量导入面板 */}
        {activePanel === 'import' && (
          <motion.div key="import" {...disclosureMotion} className="overflow-hidden">
            <div className="border-t border-border/30 px-3 py-2 bg-muted/10 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{t('memory.batch_import')}</span>
                <DsButton variant="ghost" size="icon" iconOnly onClick={() => setActivePanel(null)} className="!h-5 !w-5 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11" aria-label={t('common:actions.close')}><X size={12} /></DsButton>
              </div>
              <Textarea
                placeholder={t('memory.batch_import_placeholder')}
                value={batchImportText}
                onChange={(e) => setBatchImportText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); setActivePanel(null); }
                  else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isImporting && batchImportText.trim()) {
                    e.preventDefault();
                    handleBatchImport();
                  }
                }}
                rows={4}
                className="w-full px-2 py-1.5 text-xs [@media(pointer:coarse)]:text-[16px] bg-muted/30 border-transparent rounded-md resize-none focus-visible:border-border focus-visible:bg-background min-h-0"
              />
              <div className="flex items-center gap-2">
                <span className="text-2xs text-muted-foreground">{t('memory.type')}:</span>
                {(['fact', 'study', 'note'] as const).map(type => (
                  <button key={type} onClick={() => setBatchImportType(type)}
                    className={cn('px-1.5 py-0.5 rounded text-2xs [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11', batchImportType === type ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:bg-[var(--interactive-hover)]')}
                  >
                    {type === 'fact' ? t('memory.type_fact') : type === 'study' ? t('memory.type_study') : t('memory.type_note')}
                  </button>
                ))}
                <div className="flex-1" />
                <DsButton variant="primary" size="sm" onClick={handleBatchImport} disabled={isImporting || !batchImportText.trim()} className="!h-6 !px-2 text-xs [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-3">
                  {isImporting && <CircleNotch size={12} className="animate-spin" />}
                  {t('memory.batch_import_confirm')}
                </DsButton>
              </div>
            </div>
          </motion.div>
        )}

        {/* 新建记忆面板 */}
        {activePanel === 'new' && (
          <motion.div key="new" {...disclosureMotion} className="overflow-hidden">
            <div className="border-t border-border/30 px-3 py-2 bg-muted/10 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{t('memory.create_title')}</span>
                <DsButton variant="ghost" size="icon" iconOnly onClick={() => setActivePanel(null)} className="!h-5 !w-5 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11" aria-label={t('common:actions.close')}><X size={12} /></DsButton>
              </div>
              <Input
                placeholder={t('memory.title_placeholder')}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setActivePanel(null); } }}
                autoFocus
                className="w-full h-7 px-2 text-xs bg-muted/30 border-transparent rounded-md focus-visible:border-border focus-visible:bg-background [@media(pointer:coarse)]:!h-11"
              />
              <Textarea
                placeholder={t('memory.content_placeholder_study')}
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); setActivePanel(null); }
                  else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isCreating && newTitle.trim() && newContent.trim()) {
                    e.preventDefault();
                    handleCreateMemory();
                  }
                }}
                rows={3}
                className="w-full px-2 py-1.5 text-xs [@media(pointer:coarse)]:text-[16px] bg-muted/30 border-transparent rounded-md resize-none focus-visible:border-border focus-visible:bg-background min-h-0"
              />
              <div className="flex items-center gap-2">
                <span className="text-2xs text-muted-foreground">{t('memory.type')}:</span>
                {(['fact', 'study', 'note'] as const).map(type => (
                  <button key={type} onClick={() => setNewType(type)}
                    className={cn('px-1.5 py-0.5 rounded text-2xs [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11', newType === type ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:bg-[var(--interactive-hover)]')}
                  >
                    {type === 'fact' ? t('memory.type_fact') : type === 'study' ? t('memory.type_study') : t('memory.type_note')}
                  </button>
                ))}
                <div className="flex-1" />
                <DsButton variant="primary" size="sm" onClick={handleCreateMemory} disabled={isCreating || !newTitle.trim() || !newContent.trim()} className="!h-6 !px-2 text-xs [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-3">
                  {isCreating && <CircleNotch size={12} className="animate-spin" />}
                  {t('common:create')}
                </DsButton>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

MemoryFolderBanner.displayName = 'MemoryFolderBanner';

export default MemoryFolderBanner;
