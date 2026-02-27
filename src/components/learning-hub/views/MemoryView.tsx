import { unifiedConfirm } from '@/utils/unifiedDialogs';
import { consumePendingMemoryLocate } from '@/utils/pendingMemoryLocate';
/**
 * MemoryView - VFS Memory 管理视图
 *
 * ★ 2026-01：集成到 Learning Hub
 * ★ 2026-02：内联预览 + 跳转编辑器，移除编辑对话框
 *
 * 功能：
 * 1. 显示记忆列表（基于 VFS 笔记）
 * 2. 搜索记忆
 * 3. 创建/编辑/删除记忆
 * 4. 配置记忆根文件夹
 * 5. 内联展开预览，点击跳转到笔记编辑器
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  Search,
  Plus,
  Trash2,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  Settings,
  FileText,
  Loader2,
  AlertCircle,
  ChevronRight,
  Download,
  CheckSquare,
  Square,
  Edit3,
  Save,
  X,
  Star,
  Clock,
  History,
  Filter,
  ChevronDown,
  CheckCircle2,
  XCircle,
  Zap,
  Bot,
  User,
  BookOpen,
} from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { MemoryIcon } from '../icons/ResourceIcons';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  getMemoryConfig,
  setMemoryRootFolder,
  createMemoryRootFolder,
  searchMemory,
  readMemory,
  writeMemorySmart,
  listMemory,
  deleteMemory,
  updateMemoryById,
  exportAllMemories,
  getMemoryProfile,
  getMemoryAuditLogs,
  setMemoryAutoExtractFrequency,
  type AutoExtractFrequency,
  type MemoryConfig,
  type MemoryListItem,
  type MemorySearchResult,
  type MemoryReadOutput,
  type MemoryProfileSection,
  type MemoryAuditLogItem,
} from '@/api/memoryApi';
import { folderApi } from '@/dstu';
import type { FolderTreeNode } from '@/dstu/types/folder';
import type { ResourceListItem } from '../types';

// ============================================================================
// 类型定义
// ============================================================================

interface MemoryViewProps {
  className?: string;
  /** 打开应用回调 - 用于在右侧面板打开笔记编辑器 */
  onOpenApp?: (item: ResourceListItem) => void;
}

// ============================================================================
// 主组件
// ============================================================================

export const MemoryView: React.FC<MemoryViewProps> = ({ className, onOpenApp }) => {
  const { t } = useTranslation(['learningHub', 'common']);

  // ========== 状态 ==========
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [memories, setMemories] = useState<MemoryListItem[]>([]);
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 对话框状态
  const [isCreatingInline, setIsCreatingInline] = useState(false);
  const [showCreateRootDialog, setShowCreateRootDialog] = useState(false);
  
  // 文件夹列表（用于选择根文件夹）
  const [folderList, setFolderList] = useState<Array<{ id: string; title: string }>>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  // ★ 画像状态
  const [profileSections, setProfileSections] = useState<MemoryProfileSection[]>([]);
  const [showProfile, setShowProfile] = useState(false);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);

  // ★ 内联展开状态
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | null>(null);
  const [expandedContent, setExpandedContent] = useState<MemoryReadOutput | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  // 创建记忆状态
  const [newMemoryTitle, setNewMemoryTitle] = useState('');
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [newRootFolderTitle, setNewRootFolderTitle] = useState('');

  // ★ 批量选择状态
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ★ 内联编辑状态
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  // ★ 审计日志状态
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [auditLogs, setAuditLogs] = useState<MemoryAuditLogItem[]>([]);
  const [isLoadingAuditLog, setIsLoadingAuditLog] = useState(false);
  const [auditSourceFilter, setAuditSourceFilter] = useState<string>('');
  const [auditSuccessFilter, setAuditSuccessFilter] = useState<string>('');
  const [auditLogOffset, setAuditLogOffset] = useState(0);
  const AUDIT_LOG_PAGE_SIZE = 30;

  // ========== 加载配置和记忆列表 ==========
  const loadConfig = useCallback(async () => {
    try {
      const cfg = await getMemoryConfig();
      setConfig(cfg);
      setLoadError(null);
    } catch (error: unknown) {
      console.error('[MemoryView] Failed to load config:', error);
      const errorMsg = t('memory.config_load_error', '读取记忆配置失败。请重试，或前往数据治理检查数据库状态。');
      setLoadError(errorMsg);
    }
  }, [t]);

  const loadMemories = useCallback(async () => {
    if (!config?.memoryRootFolderId) return;

    setIsLoading(true);
    try {
      const items = await listMemory(undefined, 100);
      setMemories(items);
      setLoadError(null);
    } catch (error: unknown) {
      console.error('[MemoryView] Failed to load memories:', error);
      const errorMsg = t('memory.load_error', '加载记忆失败');
      setLoadError(errorMsg);
    } finally {
      setIsLoading(false);
    }
  }, [config?.memoryRootFolderId, t]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (config?.memoryRootFolderId) {
      loadMemories();
    }
  }, [config?.memoryRootFolderId, loadMemories]);

  // ========== 搜索 ==========
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setIsSearchMode(false);
      setSearchResults([]);
      return;
    }

    setIsLoading(true);
    setIsSearchMode(true);
    try {
      const results = await searchMemory(searchQuery, 20);
      setSearchResults(results);
    } catch (error: unknown) {
      console.error('[MemoryView] Search failed:', error);
      showGlobalNotification('error', t('memory.search_error', '搜索失败'));
    } finally {
      setIsLoading(false);
    }
  }, [searchQuery, t]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setIsSearchMode(false);
    setSearchResults([]);
  }, []);

  // ========== 创建记忆 ==========
  const handleCreateMemory = useCallback(async () => {
    if (!newMemoryTitle.trim() || !newMemoryContent.trim()) {
      showGlobalNotification('error', t('memory.empty_content', '标题和内容不能为空'));
      return;
    }

    setIsLoading(true);
    try {
      const result = await writeMemorySmart(newMemoryTitle, newMemoryContent);
      let msg: string;
      let level: 'success' | 'warning' = 'success';
      if (result.downgraded) {
        msg = t('memory.create_downgraded', '置信度不足，未自动写入。请确认后手动保存。');
        level = 'warning';
      } else if (result.event === 'NONE') {
        msg = t('memory.create_already_exists', '该记忆已存在，无需重复创建');
        level = 'warning';
      } else {
        msg = t('memory.create_success', '记忆创建成功');
      }
      showGlobalNotification(level, msg);
      setIsCreatingInline(false);
      setNewMemoryTitle('');
      setNewMemoryContent('');
      loadMemories();
    } catch (error: unknown) {
      console.error('[MemoryView] Create failed:', error);
      showGlobalNotification('error', t('memory.create_error', '创建失败'));
    } finally {
      setIsLoading(false);
    }
  }, [newMemoryTitle, newMemoryContent, t, loadMemories]);

  const handleCancelCreate = useCallback(() => {
    setIsCreatingInline(false);
    setNewMemoryTitle('');
    setNewMemoryContent('');
  }, []);

  // ========== 内联展开预览 ==========
  const handleToggleExpand = useCallback(async (noteId: string) => {
    // 如果已经展开，则收起
    if (expandedMemoryId === noteId) {
      setExpandedMemoryId(null);
      setExpandedContent(null);
      return;
    }

    setExpandedMemoryId(noteId);
    setIsLoadingContent(true);
    try {
      const memory = await readMemory(noteId);
      if (memory) {
        setExpandedContent(memory);
      } else {
        showGlobalNotification(
          'warning',
          t('memory.read_not_found', '未找到该记忆，可能已被删除。请先刷新列表，再重试打开。')
        );
        setExpandedMemoryId(null);
      }
    } catch (error: unknown) {
      console.error('[MemoryView] Read failed:', error);
      showGlobalNotification('error', t('memory.read_error', '读取失败'));
      setExpandedMemoryId(null);
    } finally {
      setIsLoadingContent(false);
    }
  }, [expandedMemoryId, t]);

  // ========== 跳转到笔记编辑器 ==========
  const handleOpenInEditor = useCallback((noteId: string, title: string) => {
    if (onOpenApp) {
      // 通过 onOpenApp 回调在右侧面板打开笔记编辑器
      onOpenApp({
        id: noteId,
        title: title,
        type: 'note',
        previewType: 'markdown',
        updatedAt: Date.now(),
        sourceDb: 'notes',
        path: `/${noteId}`,
      });
    } else {
      // 回退方案：通过事件通知
      window.dispatchEvent(new CustomEvent('learningHubOpenNote', {
        detail: { noteId },
      }));
    }
  }, [onOpenApp]);

  useEffect(() => {
    const locateId = consumePendingMemoryLocate();
    if (!locateId || !config) return;

    if (config.memoryRootFolderId) {
      // ★ 直接展开预览 + 打开编辑器
      handleToggleExpand(locateId);
      return;
    }

    showGlobalNotification(
      'warning',
      t('memory.locate_requires_root', '无法打开该记忆：请先在记忆管理中设置记忆根文件夹。')
    );
  }, [config, handleToggleExpand, t]);

  // ★ 修复风险3：删除记忆
  const handleDeleteMemory = useCallback(async (noteId: string) => {
    if (!unifiedConfirm(t('memory.delete_confirm', '确定要删除这条记忆吗？'))) return;

    setIsLoading(true);
    try {
      await deleteMemory(noteId);
      showGlobalNotification('success', t('memory.delete_success', '记忆已删除'));
      // 如果正在展开的记忆被删除，收起展开
      if (expandedMemoryId === noteId) {
        setExpandedMemoryId(null);
        setExpandedContent(null);
      }
      loadMemories();
    } catch (error: unknown) {
      console.error('[MemoryView] Delete failed:', error);
      showGlobalNotification('error', t('memory.delete_error', '删除失败'));
    } finally {
      setIsLoading(false);
    }
  }, [t, loadMemories, expandedMemoryId]);

  // ========== 批量删除 ==========
  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    if (!unifiedConfirm(t('memory.batch_delete_confirm', `确定要删除选中的 ${selectedIds.size} 条记忆吗？`))) return;

    setIsLoading(true);
    try {
      const results = await Promise.allSettled(
        Array.from(selectedIds).map((id) => deleteMemory(id))
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        showGlobalNotification('warning', t('memory.batch_delete_partial', `已删除 ${selectedIds.size - failed} 条记忆，${failed} 条失败`));
      } else {
        showGlobalNotification('success', t('memory.batch_delete_success', `已删除 ${selectedIds.size} 条记忆`));
      }
      setSelectedIds(new Set());
      setBatchMode(false);
      if (expandedMemoryId && selectedIds.has(expandedMemoryId)) {
        setExpandedMemoryId(null);
        setExpandedContent(null);
      }
      loadMemories();
    } catch (error: unknown) {
      console.error('[MemoryView] Batch delete failed:', error);
      showGlobalNotification('error', t('memory.batch_delete_error', '批量删除失败'));
    } finally {
      setIsLoading(false);
    }
  }, [selectedIds, t, loadMemories, expandedMemoryId]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ========== 导出记忆 ==========
  const handleExportMemories = useCallback(async () => {
    setIsLoading(true);
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
    } catch (error: unknown) {
      console.error('[MemoryView] Export failed:', error);
      showGlobalNotification('error', t('memory.export_error', '导出失败'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // ========== 内联编辑 ==========
  const handleStartEdit = useCallback((noteId: string, content: string) => {
    setEditingMemoryId(noteId);
    setEditContent(content);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingMemoryId) return;
    setIsLoading(true);
    try {
      await updateMemoryById(editingMemoryId, undefined, editContent);
      showGlobalNotification('success', t('memory.edit_success', '记忆已更新'));
      setEditingMemoryId(null);
      setEditContent('');
      if (expandedMemoryId === editingMemoryId) {
        const updated = await readMemory(editingMemoryId);
        if (updated) setExpandedContent(updated);
      }
      loadMemories();
    } catch (error: unknown) {
      console.error('[MemoryView] Edit failed:', error);
      showGlobalNotification('error', t('memory.edit_error', '更新失败'));
    } finally {
      setIsLoading(false);
    }
  }, [editingMemoryId, editContent, t, expandedMemoryId, loadMemories]);

  const handleCancelEdit = useCallback(() => {
    setEditingMemoryId(null);
    setEditContent('');
  }, []);

  // ========== 加载画像 ==========
  const handleToggleProfile = useCallback(async () => {
    if (showProfile) {
      setShowProfile(false);
      return;
    }
    setIsLoadingProfile(true);
    setShowProfile(true);
    try {
      const sections = await getMemoryProfile();
      setProfileSections(sections);
    } catch (error: unknown) {
      console.error('[MemoryView] Load profile failed:', error);
      setProfileSections([]);
    } finally {
      setIsLoadingProfile(false);
    }
  }, [showProfile]);

  // ========== 审计日志 ==========
  const loadAuditLogs = useCallback(async (resetOffset = true) => {
    setIsLoadingAuditLog(true);
    const offset = resetOffset ? 0 : auditLogOffset;
    if (resetOffset) setAuditLogOffset(0);
    try {
      const logs = await getMemoryAuditLogs({
        limit: AUDIT_LOG_PAGE_SIZE,
        offset,
        sourceFilter: auditSourceFilter || undefined,
        successFilter: auditSuccessFilter === '' ? undefined : auditSuccessFilter === 'true',
      });
      if (resetOffset) {
        setAuditLogs(logs);
      } else {
        setAuditLogs(prev => [...prev, ...logs]);
      }
    } catch (error: unknown) {
      console.error('[MemoryView] Load audit logs failed:', error);
    } finally {
      setIsLoadingAuditLog(false);
    }
  }, [auditSourceFilter, auditSuccessFilter, auditLogOffset]);

  const handleToggleAuditLog = useCallback(async () => {
    if (showAuditLog) {
      setShowAuditLog(false);
      return;
    }
    setShowAuditLog(true);
    setShowProfile(false);
    loadAuditLogs(true);
  }, [showAuditLog, loadAuditLogs]);

  const handleLoadMoreLogs = useCallback(() => {
    const newOffset = auditLogOffset + AUDIT_LOG_PAGE_SIZE;
    setAuditLogOffset(newOffset);
  }, [auditLogOffset]);

  useEffect(() => {
    if (showAuditLog && auditLogOffset > 0) {
      loadAuditLogs(false);
    }
  }, [auditLogOffset, showAuditLog, loadAuditLogs]);

  useEffect(() => {
    if (showAuditLog) {
      loadAuditLogs(true);
    }
  }, [auditSourceFilter, auditSuccessFilter]);

  // ========== 加载文件夹列表 ==========
  const loadFolders = useCallback(async () => {
    setLoadingFolders(true);
    try {
      const treeResult = await folderApi.getFolderTree();
      if (!treeResult.ok) {
        console.error('[MemoryView] Load folders failed:', treeResult.error);
        showGlobalNotification(
          'error',
          t('memory.folder_load_error', '加载文件夹列表失败。请重试。')
        );
        return;
      }
      const tree = treeResult.value;
      // 扁平化文件夹树
      const folders: Array<{ id: string; title: string }> = [];
      const flatten = (nodes: FolderTreeNode[], prefix = '') => {
        for (const node of nodes) {
          folders.push({
            id: node.folder.id,
            title: prefix ? `${prefix} / ${node.folder.title}` : node.folder.title,
          });
          if (node.children.length > 0) {
            flatten(node.children, prefix ? `${prefix} / ${node.folder.title}` : node.folder.title);
          }
        }
      };
      if (tree && tree.length > 0) {
        flatten(tree);
      }
      setFolderList(folders);
      setIsPickerOpen(true);
    } catch (error: unknown) {
      console.error('[MemoryView] Load folders failed:', error);
      showGlobalNotification(
        'error',
        t('memory.folder_load_error', '加载文件夹列表失败。请重试。')
      );
    } finally {
      setLoadingFolders(false);
    }
  }, [t]);

  // ========== 自动提取频率 ==========
  const handleFrequencyChange = useCallback(async (freq: AutoExtractFrequency) => {
    if (config?.autoExtractFrequency === freq) return;
    try {
      await setMemoryAutoExtractFrequency(freq);
      loadConfig();
      showGlobalNotification('success', t('memory.frequency_changed', '自动提取频率已更新'));
    } catch (error: unknown) {
      console.error('[MemoryView] Set frequency failed:', error);
      showGlobalNotification('error', t('memory.frequency_change_error', '设置失败'));
    }
  }, [t, loadConfig, config?.autoExtractFrequency]);

  // ========== 设置根文件夹 ==========
  const handleSelectRootFolder = useCallback(async (folderId: string) => {
    try {
      await setMemoryRootFolder(folderId);
      showGlobalNotification('success', t('memory.root_set_success', '记忆根文件夹已设置'));
      loadConfig();
    } catch (error: unknown) {
      console.error('[MemoryView] Set root folder failed:', error);
      showGlobalNotification('error', t('memory.root_set_error', '设置失败'));
    }
  }, [t, loadConfig]);

  const handleCreateRootFolder = useCallback(async () => {
    if (!newRootFolderTitle.trim()) {
      showGlobalNotification('error', t('memory.empty_folder_title', '文件夹名称不能为空'));
      return;
    }

    setIsLoading(true);
    try {
      await createMemoryRootFolder(newRootFolderTitle);
      showGlobalNotification('success', t('memory.root_create_success', '记忆根文件夹已创建'));
      setShowCreateRootDialog(false);
      setNewRootFolderTitle('');
      loadConfig();
    } catch (error: unknown) {
      console.error('[MemoryView] Create root folder failed:', error);
      showGlobalNotification('error', t('memory.root_create_error', '创建失败'));
    } finally {
      setIsLoading(false);
    }
  }, [newRootFolderTitle, t, loadConfig]);

  // ========== 渲染：配置加载失败 - 内嵌错误态 ==========
  if (loadError && !config) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full p-8', className)}>
        <AlertCircle size={48} className="text-destructive/60 mb-4" />
        <h2 className="text-lg font-medium mb-1.5">
          {t('memory.load_error_title', '加载失败')}
        </h2>
        <p className="text-sm text-muted-foreground text-center mb-6 max-w-sm">
          {loadError}
        </p>
        <NotionButton
          variant="primary"
          size="md"
          onClick={loadConfig}
          disabled={isLoading}
        >
          <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
          {t('common:retry', '重试')}
        </NotionButton>
      </div>
    );
  }

  // ========== 渲染：未配置根文件夹 - Notion 风格 ==========
  if (!config?.memoryRootFolderId) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full p-8', className)}>
        <MemoryIcon size={48} className="text-muted-foreground/40 mb-4" />
        <h2 className="text-lg font-medium mb-1.5">
          {t('memory.setup_title', '设置记忆存储位置')}
        </h2>
        <p className="text-sm text-muted-foreground text-center mb-6 max-w-sm">
          {t('memory.setup_description', 'VFS 记忆系统将记忆存储为普通笔记文件。请选择或创建一个文件夹作为记忆根目录。')}
        </p>
        
        {/* 文件夹列表 */}
        {folderList.length > 0 ? (
          <div className="w-full max-w-sm mb-4">
            <p className="text-xs text-muted-foreground mb-2">{t('memory.select_folder', '选择现有文件夹')}:</p>
            <CustomScrollArea className="rounded-lg bg-muted/30 max-h-40">
              <div className="p-1">
                {folderList.map((folder) => (
                  <NotionButton
                    key={folder.id}
                    variant="ghost" size="sm"
                    className="w-full !justify-start !px-3 !py-2"
                    onClick={() => handleSelectRootFolder(folder.id)}
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="truncate">{folder.title}</span>
                  </NotionButton>
                ))}
              </div>
            </CustomScrollArea>
          </div>
        ) : (
          <NotionButton variant="ghost" size="sm" onClick={loadFolders} disabled={loadingFolders} className="mb-4">
            {loadingFolders ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FolderOpen className="w-4 h-4" />
            )}
            {t('memory.select_folder', '选择现有文件夹')}
          </NotionButton>
        )}
        
        <div className="text-xs text-muted-foreground/60 mb-3">{t('common:or', '或')}</div>
        
        <NotionButton variant="ghost" size="sm" onClick={() => setShowCreateRootDialog(true)} className="text-primary hover:bg-primary/10">
          <Plus className="w-4 h-4" />
          {t('memory.create_folder', '创建新文件夹')}
        </NotionButton>

        {/* 创建根文件夹对话框 - Notion 风格 */}
        <NotionDialog open={showCreateRootDialog} onOpenChange={setShowCreateRootDialog} maxWidth="max-w-sm">
          <NotionDialogHeader>
            <NotionDialogTitle className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-muted-foreground" />
              {t('memory.create_root_title', '创建记忆文件夹')}
            </NotionDialogTitle>
          </NotionDialogHeader>
          <NotionDialogBody nativeScroll>
            <input
              placeholder={t('memory.folder_name_placeholder', '输入文件夹名称')}
              value={newRootFolderTitle}
              onChange={(e) => setNewRootFolderTitle(e.target.value)}
              className="w-full h-9 px-3 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
            />
          </NotionDialogBody>
          <NotionDialogFooter>
            <NotionButton variant="ghost" size="sm" onClick={() => setShowCreateRootDialog(false)}>
              {t('common:cancel', '取消')}
            </NotionButton>
            <NotionButton variant="primary" size="sm" onClick={handleCreateRootFolder} disabled={isLoading || !newRootFolderTitle.trim()}>
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('common:create', '创建')}
            </NotionButton>
          </NotionDialogFooter>
        </NotionDialog>
      </div>
    );
  }

  // ========== 渲染：主视图 ==========
  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 顶部工具栏 - Notion 风格 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40">
        {/* 搜索框 */}
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
          <input
            placeholder={t('memory.search_placeholder', '搜索记忆...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="w-full h-9 pl-9 pr-8 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
          />
          {searchQuery && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleClearSearch} className="absolute right-3 top-1/2 -translate-y-1/2 !h-5 !w-5 !p-0 text-muted-foreground/60 hover:text-foreground" aria-label="clear">
              ×
            </NotionButton>
          )}
        </div>

        {/* 操作按钮 */}
        <NotionButton variant="ghost" size="icon" iconOnly onClick={loadMemories} disabled={isLoading} aria-label="refresh">
          <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
        </NotionButton>
        <NotionButton
          variant="ghost" size="icon" iconOnly
          onClick={() => { setBatchMode(!batchMode); setSelectedIds(new Set()); }}
          className={cn(batchMode && 'text-primary bg-primary/10')}
          aria-label="batch"
        >
          <CheckSquare className="w-4 h-4" />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleExportMemories} disabled={isLoading} aria-label="export">
          <Download className="w-4 h-4" />
        </NotionButton>
        <NotionButton
          variant="ghost" size="icon" iconOnly
          onClick={handleToggleProfile}
          className={cn(showProfile && 'text-primary bg-primary/10')}
          aria-label="profile"
        >
          <MemoryIcon size={16} />
        </NotionButton>
        <NotionButton
          variant="ghost" size="icon" iconOnly
          onClick={handleToggleAuditLog}
          className={cn(showAuditLog && 'text-primary bg-primary/10')}
          aria-label="audit log"
          title={t('memory.audit_log', '操作日志')}
        >
          <History className="w-4 h-4" />
        </NotionButton>
        {!isCreatingInline && !batchMode && (
          <NotionButton variant="ghost" size="sm" onClick={() => setIsCreatingInline(true)} className="text-primary hover:bg-primary/10">
            <Plus className="w-4 h-4" />
            {t('memory.new', '新建')}
          </NotionButton>
        )}
        {batchMode && (
          <>
            <NotionButton
              variant="ghost" size="sm"
              onClick={() => {
                if (selectedIds.size === memories.length) {
                  setSelectedIds(new Set());
                } else {
                  setSelectedIds(new Set(memories.map(m => m.id)));
                }
              }}
              className="text-muted-foreground hover:bg-muted/40"
            >
              {selectedIds.size === memories.length ? t('memory.deselect_all', '取消全选') : t('memory.select_all', '全选')}
            </NotionButton>
            {selectedIds.size > 0 && (
              <NotionButton variant="ghost" size="sm" onClick={handleBatchDelete} disabled={isLoading} className="text-rose-500 hover:bg-rose-500/10">
                <Trash2 className="w-4 h-4" />
                {t('memory.batch_delete', `删除(${selectedIds.size})`)}
              </NotionButton>
            )}
          </>
        )}
      </div>

      {/* 当前根文件夹 + 提取频率设置 */}
      <div className="px-4 py-2 text-xs text-muted-foreground space-y-1.5 border-b border-border/30">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-3.5 h-3.5" />
          <span>{t('memory.root_folder', '根文件夹')}:</span>
          <span className="font-medium text-foreground">{config.memoryRootFolderTitle || t('memory.defaultRootTitle', '记忆')}</span>
          <NotionButton variant="ghost" size="sm" onClick={loadFolders} disabled={loadingFolders} className="ml-auto !h-auto !px-1.5 !py-0.5">
            {loadingFolders ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Settings className="w-3 h-3" />
            )}
            {t('memory.change', '更改')}
          </NotionButton>
        </div>
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5" />
          <span>{t('memory.auto_extract', '自动提取')}:</span>
          <div className="flex items-center gap-0.5 ml-1">
            {([
              { value: 'off' as const, label: t('memory.freq_off', '关闭') },
              { value: 'balanced' as const, label: t('memory.freq_balanced', '平衡') },
              { value: 'aggressive' as const, label: t('memory.freq_aggressive', '积极') },
            ]).map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleFrequencyChange(opt.value)}
                className={cn(
                  'px-2 py-0.5 rounded text-[11px] transition-colors',
                  config.autoExtractFrequency === opt.value
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 记忆列表 */}
      <CustomScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {/* 画像汇总 */}
          {showProfile && (
            <div className="rounded-lg border border-border/60 bg-card/50 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30 bg-muted/20">
                <MemoryIcon size={14} className="text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">{t('memory.profile_title', '系统对我的了解')}</span>
              </div>
              {isLoadingProfile ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              ) : profileSections.length === 0 ? (
                <div className="px-4 py-4 text-xs text-muted-foreground/60 text-center">
                  {t('memory.profile_empty', '暂无画像数据。系统会在对话中自动积累你的偏好和背景。')}
                </div>
              ) : (
                <div className="px-4 py-3 space-y-3">
                  {profileSections.map((section) => (
                    <div key={section.category}>
                      <div className="text-[11px] font-medium text-foreground/70 mb-1">{section.category}</div>
                      <div className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">{section.content}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 审计日志面板 */}
          {showAuditLog && (
            <div className="rounded-lg border border-border/60 bg-card/50 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30 bg-muted/20">
                <History size={14} className="text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">{t('memory.audit_log', '操作日志')}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  {/* 来源筛选 */}
                  <select
                    value={auditSourceFilter}
                    onChange={(e) => setAuditSourceFilter(e.target.value)}
                    className="h-6 px-1.5 text-[10px] bg-muted/40 border-none rounded focus:outline-none"
                  >
                    <option value="">{t('memory.audit_all_sources', '全部来源')}</option>
                    <option value="tool_call">{t('memory.audit_source_tool', '工具调用')}</option>
                    <option value="auto_extract">{t('memory.audit_source_auto', '自动提取')}</option>
                    <option value="handler">{t('memory.audit_source_handler', '前端操作')}</option>
                    <option value="evolution">{t('memory.audit_source_evolution', '自进化')}</option>
                  </select>
                  {/* 成功/失败筛选 */}
                  <select
                    value={auditSuccessFilter}
                    onChange={(e) => setAuditSuccessFilter(e.target.value)}
                    className="h-6 px-1.5 text-[10px] bg-muted/40 border-none rounded focus:outline-none"
                  >
                    <option value="">{t('memory.audit_all_status', '全部状态')}</option>
                    <option value="true">{t('memory.audit_success', '成功')}</option>
                    <option value="false">{t('memory.audit_failed', '失败')}</option>
                  </select>
                  <NotionButton variant="ghost" size="icon" iconOnly onClick={() => loadAuditLogs(true)} disabled={isLoadingAuditLog} className="!h-5 !w-5 !p-0" aria-label="refresh logs">
                    <RefreshCw className={cn('w-3 h-3', isLoadingAuditLog && 'animate-spin')} />
                  </NotionButton>
                </div>
              </div>
              {isLoadingAuditLog && auditLogs.length === 0 ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              ) : auditLogs.length === 0 ? (
                <div className="px-4 py-4 text-xs text-muted-foreground/60 text-center">
                  {t('memory.audit_empty', '暂无操作日志')}
                </div>
              ) : (
                <div>
                  <div className="divide-y divide-border/20">
                    {auditLogs.map((log) => (
                      <AuditLogRow key={log.id} log={log} />
                    ))}
                  </div>
                  {auditLogs.length >= auditLogOffset + AUDIT_LOG_PAGE_SIZE && (
                    <div className="flex justify-center py-2 border-t border-border/20">
                      <NotionButton variant="ghost" size="sm" onClick={handleLoadMoreLogs} disabled={isLoadingAuditLog} className="text-xs text-muted-foreground">
                        {isLoadingAuditLog ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                        {t('memory.audit_load_more', '加载更多')}
                      </NotionButton>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 内联创建表单 */}
          {isCreatingInline && (
            <div className="rounded-lg border border-border/60 bg-card/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MemoryIcon size={16} />
                  <span className="text-sm font-medium">{t('memory.create_title', '创建新记忆')}</span>
                </div>
                <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCancelCreate} disabled={isLoading} aria-label="cancel">
                  <Plus className="w-4 h-4 rotate-45" />
                </NotionButton>
              </div>

              <input
                placeholder={t('memory.title_placeholder', '记忆标题')}
                value={newMemoryTitle}
                onChange={(e) => setNewMemoryTitle(e.target.value)}
                autoFocus
                className="w-full h-9 px-3 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
              />
              <textarea
                placeholder={t('memory.content_placeholder', '记忆内容...')}
                value={newMemoryContent}
                onChange={(e) => setNewMemoryContent(e.target.value)}
                rows={5}
                className="w-full px-3 py-2 text-sm bg-muted/30 border-transparent rounded-md resize-none focus:border-border focus:bg-background focus:outline-none transition-colors"
              />

              <div className="flex gap-2 pt-1">
                <NotionButton variant="ghost" size="sm" onClick={handleCancelCreate} disabled={isLoading} className="flex-1 !h-9">
                  {t('common:cancel', '取消')}
                </NotionButton>
                <NotionButton variant="primary" size="sm" onClick={handleCreateMemory} disabled={isLoading || !newMemoryTitle.trim() || !newMemoryContent.trim()} className="flex-1 !h-9">
                  {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {t('common:create', '创建')}
                </NotionButton>
              </div>
            </div>
          )}

          {/* 列表内容 - Notion 风格 */}
          {isLoading && memories.length === 0 && !loadError ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : loadError && !isSearchMode ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <AlertCircle className="w-8 h-8 mb-2 text-destructive/60" />
              <span className="text-sm mb-1 text-foreground font-medium">
                {t('memory.load_error_title', '加载失败')}
              </span>
              <span className="text-xs mb-3 text-center max-w-xs">{loadError}</span>
              <NotionButton
                variant="primary"
                size="sm"
                onClick={loadMemories}
                disabled={isLoading}
              >
                <RefreshCw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} />
                {t('common:retry', '重试')}
              </NotionButton>
            </div>
          ) : isSearchMode ? (
            // 搜索结果
            searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Search className="w-8 h-8 mb-2 opacity-40" />
                <span className="text-sm">{t('memory.no_results', '没有找到相关记忆')}</span>
              </div>
            ) : (
              <div className="space-y-0.5">
                {searchResults.map((result) => {
                  const isExpanded = expandedMemoryId === result.noteId;
                  return (
                    <div key={result.noteId} className="rounded-lg transition-colors">
                      <NotionButton variant="ghost" size="sm"
                        className={cn(
                          'w-full !justify-start !px-3 !py-2.5 !h-auto text-left',
                          isExpanded ? 'bg-muted/50' : 'hover:bg-muted/40'
                        )}
                        onClick={() => handleToggleExpand(result.noteId)}
                      >
                        <div className="flex items-center gap-2 mb-0.5">
                          <ChevronRight className={cn(
                            'w-3.5 h-3.5 text-muted-foreground transition-transform duration-200',
                            isExpanded && 'rotate-90'
                          )} />
                          <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="text-sm font-medium truncate">{result.noteTitle}</span>
                          <span className="text-[10px] text-muted-foreground/60 ml-auto">
                            {(result.score * 100).toFixed(0)}%
                          </span>
                        </div>
                        {!isExpanded && (
                          <p className="text-xs text-muted-foreground line-clamp-1 pl-7">
                            {result.chunkText}
                          </p>
                        )}
                      </NotionButton>
                      {/* 内联展开预览 + 编辑 */}
                      {isExpanded && (
                        <div className="mx-3 mb-2 rounded-md border border-border/40 bg-card/50 overflow-hidden">
                          {isLoadingContent ? (
                            <div className="flex items-center justify-center py-6">
                              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                            </div>
                          ) : expandedContent ? (
                            <>
                              {editingMemoryId === result.noteId ? (
                                <div className="p-3 space-y-2">
                                  <textarea
                                    value={editContent}
                                    onChange={(e) => setEditContent(e.target.value)}
                                    rows={4}
                                    autoFocus
                                    className="w-full px-3 py-2 text-xs bg-muted/30 border-transparent rounded-md resize-none focus:border-border focus:bg-background focus:outline-none transition-colors"
                                  />
                                  <div className="flex gap-2">
                                    <NotionButton variant="ghost" size="sm" onClick={handleCancelEdit} className="!h-auto !px-2 !py-1 text-xs">
                                      <X className="w-3 h-3" />
                                      {t('common:cancel', '取消')}
                                    </NotionButton>
                                    <NotionButton variant="primary" size="sm" onClick={handleSaveEdit} disabled={isLoading} className="!h-auto !px-2 !py-1 text-xs">
                                      <Save className="w-3 h-3" />
                                      {t('common:save', '保存')}
                                    </NotionButton>
                                  </div>
                                </div>
                              ) : (
                                <div className="px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap line-clamp-6 leading-relaxed">
                                  {expandedContent.content || t('memory.no_content', '（无内容）')}
                                </div>
                              )}
                              <div className="flex items-center justify-between px-3 py-2 border-t border-border/30 bg-muted/20">
                                <div className="flex items-center gap-1.5">
                                  <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDeleteMemory(result.noteId); }} className="text-rose-500 hover:bg-rose-500/10 !h-auto !px-2 !py-1 text-xs">
                                    <Trash2 className="w-3 h-3" />
                                    {t('common:delete', '删除')}
                                  </NotionButton>
                                  {editingMemoryId !== result.noteId && (
                                    <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleStartEdit(result.noteId, expandedContent.content || ''); }} className="text-muted-foreground hover:bg-muted/40 !h-auto !px-2 !py-1 text-xs">
                                      <Edit3 className="w-3 h-3" />
                                      {t('memory.edit', '编辑')}
                                    </NotionButton>
                                  )}
                                </div>
                                <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleOpenInEditor(result.noteId, result.noteTitle); }} className="text-primary bg-primary/10 hover:bg-primary/15 !h-auto !px-2.5 !py-1 text-xs font-medium">
                                  <ExternalLink className="w-3 h-3" />
                                  {t('memory.open_in_editor', '在编辑器中打开')}
                                </NotionButton>
                              </div>
                            </>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : memories.length === 0 ? (
            // 空状态 - 更简洁
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <MemoryIcon size={40} className="mb-3 opacity-40" />
              <span className="text-sm mb-2">{t('memory.empty', '暂无记忆')}</span>
              <NotionButton variant="ghost" size="sm" onClick={() => setIsCreatingInline(true)} className="text-primary hover:underline !p-0 !h-auto">
                {t('memory.create_first', '创建第一条记忆')}
              </NotionButton>
            </div>
          ) : (
            // 记忆列表 - 内联展开布局 + 批量选择 + 内联编辑
            <div className="space-y-0.5">
              {memories.map((memory) => {
                const isExpanded = expandedMemoryId === memory.id;
                const isSelected = selectedIds.has(memory.id);
                const isEditing = editingMemoryId === memory.id;
                return (
                  <div key={memory.id} className="rounded-lg transition-colors">
                    <div
                      className={cn(
                        'group flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors',
                        isExpanded ? 'bg-muted/50' : 'hover:bg-muted/40',
                        isSelected && 'bg-primary/5'
                      )}
                      onClick={() => batchMode ? toggleSelect(memory.id) : handleToggleExpand(memory.id)}
                    >
                      {batchMode ? (
                        <span className="flex-shrink-0">
                          {isSelected ? <CheckSquare className="w-4 h-4 text-primary" /> : <Square className="w-4 h-4 text-muted-foreground" />}
                        </span>
                      ) : (
                        <ChevronRight className={cn(
                          'w-3.5 h-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-200',
                          isExpanded && 'rotate-90'
                        )} />
                      )}
                      <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium truncate">{memory.title}</span>
                          {memory.memoryType === 'note' && (
                            <span className="flex items-center gap-0.5 px-1.5 py-0 rounded bg-blue-500/10 text-blue-600 text-[9px] font-medium flex-shrink-0">
                              <BookOpen className="w-2.5 h-2.5" />
                              笔记
                            </span>
                          )}
                          {memory.isImportant && (
                            <Star className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" />
                          )}
                          {memory.isStale && (
                            <Clock className="w-3 h-3 text-muted-foreground/40 flex-shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{new Date(memory.updatedAt).toLocaleDateString()}</span>
                          {memory.folderPath && (
                            <span className="px-1.5 py-0 rounded bg-muted/50 text-[10px]">{memory.folderPath}</span>
                          )}
                          {memory.hits > 0 && (
                            <span className="text-[10px] text-muted-foreground/50">{memory.hits} {t('memory.hits', '次引用')}</span>
                          )}
                        </div>
                      </div>
                      {!batchMode && (
                        <NotionButton variant="ghost" size="icon" iconOnly className="!p-1.5 text-muted-foreground/0 group-hover:text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10" onClick={(event) => { event.stopPropagation(); handleDeleteMemory(memory.id); }} aria-label="delete">
                          <Trash2 className="w-3.5 h-3.5" />
                        </NotionButton>
                      )}
                    </div>
                    {/* 内联展开预览 + 编辑 */}
                    {isExpanded && !batchMode && (
                      <div className="mx-3 mb-2 rounded-md border border-border/40 bg-card/50 overflow-hidden">
                        {isLoadingContent ? (
                          <div className="flex items-center justify-center py-6">
                            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                          </div>
                        ) : expandedContent ? (
                          <>
                            {isEditing ? (
                              <div className="p-3 space-y-2">
                                <textarea
                                  value={editContent}
                                  onChange={(e) => setEditContent(e.target.value)}
                                  rows={4}
                                  autoFocus
                                  className="w-full px-3 py-2 text-xs bg-muted/30 border-transparent rounded-md resize-none focus:border-border focus:bg-background focus:outline-none transition-colors"
                                />
                                <div className="flex gap-2">
                                  <NotionButton variant="ghost" size="sm" onClick={handleCancelEdit} className="!h-auto !px-2 !py-1 text-xs">
                                    <X className="w-3 h-3" />
                                    {t('common:cancel', '取消')}
                                  </NotionButton>
                                  <NotionButton variant="primary" size="sm" onClick={handleSaveEdit} disabled={isLoading} className="!h-auto !px-2 !py-1 text-xs">
                                    <Save className="w-3 h-3" />
                                    {t('common:save', '保存')}
                                  </NotionButton>
                                </div>
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap line-clamp-6 leading-relaxed">
                                {expandedContent.content || t('memory.no_content', '（无内容）')}
                              </div>
                            )}
                            <div className="flex items-center justify-between px-3 py-2 border-t border-border/30 bg-muted/20">
                              <div className="flex items-center gap-1.5">
                                <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDeleteMemory(memory.id); }} className="text-rose-500 hover:bg-rose-500/10 !h-auto !px-2 !py-1 text-xs">
                                  <Trash2 className="w-3 h-3" />
                                  {t('common:delete', '删除')}
                                </NotionButton>
                                {!isEditing && (
                                  <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleStartEdit(memory.id, expandedContent.content || ''); }} className="text-muted-foreground hover:bg-muted/40 !h-auto !px-2 !py-1 text-xs">
                                    <Edit3 className="w-3 h-3" />
                                    {t('memory.edit', '编辑')}
                                  </NotionButton>
                                )}
                              </div>
                              <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleOpenInEditor(memory.id, memory.title); }} className="text-primary bg-primary/10 hover:bg-primary/15 !h-auto !px-2.5 !py-1 text-xs font-medium">
                                <ExternalLink className="w-3 h-3" />
                                {t('memory.open_in_editor', '在编辑器中打开')}
                              </NotionButton>
                            </div>
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CustomScrollArea>

      {/* 文件夹选择弹出框 */}
      <NotionDialog open={isPickerOpen} onOpenChange={setIsPickerOpen} maxWidth="max-w-md">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-muted-foreground" />
            {t('memory.select_root_folder', '选择记忆根文件夹')}
          </NotionDialogTitle>
        </NotionDialogHeader>
        <NotionDialogBody>
          <div className="py-1">
            {folderList.map((folder) => (
              <NotionButton
                key={folder.id}
                variant="ghost" size="sm"
                className="w-full !justify-start !px-3 !py-2"
                onClick={() => {
                  handleSelectRootFolder(folder.id);
                  setIsPickerOpen(false);
                }}
              >
                <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                <span className="truncate">{folder.title}</span>
              </NotionButton>
            ))}
          </div>
        </NotionDialogBody>
        <NotionDialogFooter>
          <NotionButton variant="ghost" size="sm" onClick={() => setIsPickerOpen(false)}>
            {t('common:cancel', '取消')}
          </NotionButton>
        </NotionDialogFooter>
      </NotionDialog>
    </div>
  );
};

// ============================================================================
// 审计日志行组件
// ============================================================================

const SOURCE_LABELS: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  tool_call: { label: '工具调用', icon: <Bot className="w-3 h-3" />, color: 'text-blue-500' },
  auto_extract: { label: '自动提取', icon: <Zap className="w-3 h-3" />, color: 'text-amber-500' },
  handler: { label: '前端操作', icon: <User className="w-3 h-3" />, color: 'text-emerald-500' },
  evolution: { label: '自进化', icon: <RefreshCw className="w-3 h-3" />, color: 'text-purple-500' },
};

const EVENT_COLORS: Record<string, string> = {
  ADD: 'bg-emerald-500/15 text-emerald-600',
  UPDATE: 'bg-blue-500/15 text-blue-600',
  APPEND: 'bg-sky-500/15 text-sky-600',
  DELETE: 'bg-rose-500/15 text-rose-600',
  NONE: 'bg-muted text-muted-foreground',
  FILTERED: 'bg-amber-500/15 text-amber-600',
};

const AuditLogRow: React.FC<{ log: MemoryAuditLogItem }> = ({ log }) => {
  const [expanded, setExpanded] = React.useState(false);
  const sourceMeta = SOURCE_LABELS[log.source] ?? { label: log.source, icon: null, color: 'text-muted-foreground' };
  const ts = new Date(log.timestamp);
  const timeStr = `${ts.toLocaleDateString()} ${ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

  return (
    <div className="group">
      <div
        className="flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight className={cn(
          'w-3 h-3 text-muted-foreground/50 transition-transform duration-150 flex-shrink-0',
          expanded && 'rotate-90'
        )} />

        {/* 成功/失败图标 */}
        {log.success ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-rose-500 flex-shrink-0" />
        )}

        {/* 来源 */}
        <span className={cn('flex items-center gap-1 text-[10px] font-medium flex-shrink-0', sourceMeta.color)}>
          {sourceMeta.icon}
          {sourceMeta.label}
        </span>

        {/* 操作 */}
        <span className="text-[10px] text-muted-foreground flex-shrink-0">{log.operation}</span>

        {/* 事件标签 */}
        {log.event && (
          <span className={cn(
            'px-1.5 py-0 rounded text-[9px] font-medium flex-shrink-0',
            EVENT_COLORS[log.event] ?? 'bg-muted text-muted-foreground'
          )}>
            {log.event}
          </span>
        )}

        {/* 标题 */}
        <span className="text-xs truncate flex-1 min-w-0">
          {log.title || log.contentPreview || '—'}
        </span>

        {/* 时间 */}
        <span className="text-[10px] text-muted-foreground/60 flex-shrink-0 tabular-nums">
          {timeStr}
        </span>

        {/* 耗时 */}
        {log.durationMs != null && (
          <span className="text-[10px] text-muted-foreground/40 flex-shrink-0 tabular-nums w-12 text-right">
            {log.durationMs}ms
          </span>
        )}
      </div>

      {/* 展开详情 */}
      {expanded && (
        <div className="px-4 pb-3 ml-7 space-y-1.5">
          {log.noteId && (
            <div className="text-[10px]">
              <span className="text-muted-foreground/60">Note ID: </span>
              <code className="text-[10px] bg-muted/50 px-1 rounded">{log.noteId}</code>
            </div>
          )}
          {log.contentPreview && (
            <div className="text-[10px]">
              <span className="text-muted-foreground/60">内容: </span>
              <span className="text-muted-foreground">{log.contentPreview}</span>
            </div>
          )}
          {log.folder && (
            <div className="text-[10px]">
              <span className="text-muted-foreground/60">文件夹: </span>
              <span className="text-muted-foreground">{log.folder}</span>
            </div>
          )}
          {log.confidence != null && (
            <div className="text-[10px]">
              <span className="text-muted-foreground/60">置信度: </span>
              <span className={cn(
                'font-medium',
                log.confidence >= 0.8 ? 'text-emerald-600' :
                log.confidence >= 0.5 ? 'text-amber-600' : 'text-rose-600'
              )}>
                {(log.confidence * 100).toFixed(0)}%
              </span>
            </div>
          )}
          {log.reason && (
            <div className="text-[10px]">
              <span className="text-muted-foreground/60">原因: </span>
              <span className="text-muted-foreground">{log.reason}</span>
            </div>
          )}
          {log.sessionId && (
            <div className="text-[10px]">
              <span className="text-muted-foreground/60">会话: </span>
              <code className="text-[10px] bg-muted/50 px-1 rounded">{log.sessionId}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MemoryView;
