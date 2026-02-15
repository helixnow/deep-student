import { unifiedConfirm } from '@/utils/unifiedDialogs';
import { consumePendingMemoryLocate } from '@/utils/pendingMemoryLocate';
/**
 * MemoryView - VFS Memory 管理视图
 *
 * ★ 2026-01：替代旧的 UserMemoryPage，集成到 Learning Hub
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
} from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { MemoryIcon } from '../icons/ResourceIcons';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/shad/Dialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  getMemoryConfig,
  setMemoryRootFolder,
  createMemoryRootFolder,
  searchMemory,
  readMemory,
  writeMemory,
  listMemory,
  deleteMemory,
  type MemoryConfig,
  type MemoryListItem,
  type MemorySearchResult,
  type MemoryReadOutput,
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

  // ★ 内联展开状态
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | null>(null);
  const [expandedContent, setExpandedContent] = useState<MemoryReadOutput | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  // 创建记忆状态
  const [newMemoryTitle, setNewMemoryTitle] = useState('');
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [newRootFolderTitle, setNewRootFolderTitle] = useState('');

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
      await writeMemory(newMemoryTitle, newMemoryContent, undefined, 'create');
      showGlobalNotification('success', t('memory.create_success', '记忆创建成功'));
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
        <Dialog open={showCreateRootDialog} onOpenChange={setShowCreateRootDialog}>
          <DialogContent className="max-w-sm p-0 gap-0 overflow-hidden">
            <DialogHeader className="px-5 pt-5 pb-3">
              <DialogTitle className="flex items-center gap-2 text-base font-medium">
                <FolderOpen className="w-4 h-4 text-muted-foreground" />
                {t('memory.create_root_title', '创建记忆文件夹')}
              </DialogTitle>
            </DialogHeader>
            <div className="px-5 pb-4">
              <input
                placeholder={t('memory.folder_name_placeholder', '输入文件夹名称')}
                value={newRootFolderTitle}
                onChange={(e) => setNewRootFolderTitle(e.target.value)}
                className="w-full h-9 px-3 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
              />
            </div>
            <div className="flex gap-2 px-5 py-3 border-t border-border/40 bg-muted/20">
              <NotionButton variant="ghost" size="sm" onClick={() => setShowCreateRootDialog(false)} className="flex-1 !h-9">
                {t('common:cancel', '取消')}
              </NotionButton>
              <NotionButton variant="primary" size="sm" onClick={handleCreateRootFolder} disabled={isLoading || !newRootFolderTitle.trim()} className="flex-1 !h-9">
                {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('common:create', '创建')}
              </NotionButton>
            </div>
          </DialogContent>
        </Dialog>
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

        {/* 操作按钮 - Notion 风格 */}
        <NotionButton variant="ghost" size="icon" iconOnly onClick={loadMemories} disabled={isLoading} aria-label="refresh">
          <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
        </NotionButton>
        {!isCreatingInline && (
          <NotionButton variant="ghost" size="sm" onClick={() => setIsCreatingInline(true)} className="text-primary hover:bg-primary/10">
            <Plus className="w-4 h-4" />
            {t('memory.new', '新建')}
          </NotionButton>
        )}
      </div>

      {/* 当前根文件夹信息 - 更简洁 */}
      <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
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

      {/* 记忆列表 */}
      <CustomScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {/* 内联创建表单 - Notion 风格 */}
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
                      {/* 内联展开预览 */}
                      {isExpanded && (
                        <div className="mx-3 mb-2 rounded-md border border-border/40 bg-card/50 overflow-hidden">
                          {isLoadingContent ? (
                            <div className="flex items-center justify-center py-6">
                              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                            </div>
                          ) : expandedContent ? (
                            <>
                              <div className="px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap line-clamp-6 leading-relaxed">
                                {expandedContent.content || t('memory.no_content', '（无内容）')}
                              </div>
                              <div className="flex items-center justify-between px-3 py-2 border-t border-border/30 bg-muted/20">
                                <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDeleteMemory(result.noteId); }} className="text-rose-500 hover:bg-rose-500/10 !h-auto !px-2 !py-1 text-xs">
                                  <Trash2 className="w-3 h-3" />
                                  {t('common:delete', '删除')}
                                </NotionButton>
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
            // 记忆列表 - 内联展开布局
            <div className="space-y-0.5">
              {memories.map((memory) => {
                const isExpanded = expandedMemoryId === memory.id;
                return (
                  <div key={memory.id} className="rounded-lg transition-colors">
                    <div
                      className={cn(
                        'group flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors',
                        isExpanded ? 'bg-muted/50' : 'hover:bg-muted/40'
                      )}
                      onClick={() => handleToggleExpand(memory.id)}
                    >
                      <ChevronRight className={cn(
                        'w-3.5 h-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-200',
                        isExpanded && 'rotate-90'
                      )} />
                      <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{memory.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(memory.updatedAt).toLocaleDateString()}
                        </div>
                      </div>
                      <NotionButton variant="ghost" size="icon" iconOnly className="!p-1.5 text-muted-foreground/0 group-hover:text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10" onClick={(event) => { event.stopPropagation(); handleDeleteMemory(memory.id); }} aria-label="delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </NotionButton>
                    </div>
                    {/* 内联展开预览 */}
                    {isExpanded && (
                      <div className="mx-3 mb-2 rounded-md border border-border/40 bg-card/50 overflow-hidden">
                        {isLoadingContent ? (
                          <div className="flex items-center justify-center py-6">
                            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                          </div>
                        ) : expandedContent ? (
                          <>
                            <div className="px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap line-clamp-6 leading-relaxed">
                              {expandedContent.content || t('memory.no_content', '（无内容）')}
                            </div>
                            <div className="flex items-center justify-between px-3 py-2 border-t border-border/30 bg-muted/20">
                              <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDeleteMemory(memory.id); }} className="text-rose-500 hover:bg-rose-500/10 !h-auto !px-2 !py-1 text-xs">
                                <Trash2 className="w-3 h-3" />
                                {t('common:delete', '删除')}
                              </NotionButton>
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

      {/* 文件夹选择弹出框 - 参考 FolderPickerDialog 设计 */}
      {folderList.length > 0 && (
        <Dialog open={folderList.length > 0} onOpenChange={() => setFolderList([])}>
          <DialogContent className="sm:max-w-md !p-2.5 gap-0 overflow-hidden">
            <DialogHeader className="px-5 pt-5 pb-3">
              <DialogTitle className="flex items-center gap-2 text-base font-medium">
                <FolderOpen className="w-4 h-4 text-muted-foreground" />
                {t('memory.select_root_folder', '选择记忆根文件夹')}
              </DialogTitle>
            </DialogHeader>
            
            {/* 固定高度内容区 */}
            <div className="h-[280px] overflow-hidden mb-3">
              <CustomScrollArea className="h-full" fullHeight>
                <div className="py-1 px-5">
                  {folderList.map((folder) => (
                    <NotionButton
                      key={folder.id}
                      variant="ghost" size="sm"
                      className="w-full !justify-start !px-3 !py-2"
                      onClick={() => {
                        handleSelectRootFolder(folder.id);
                        setFolderList([]);
                      }}
                    >
                      <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                      <span className="truncate">{folder.title}</span>
                    </NotionButton>
                  ))}
                </div>
              </CustomScrollArea>
            </div>
            
            {/* 底部操作区 */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/40">
              <NotionButton variant="ghost" size="sm" onClick={() => setFolderList([])}>
                {t('common:cancel', '取消')}
              </NotionButton>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};

export default MemoryView;
