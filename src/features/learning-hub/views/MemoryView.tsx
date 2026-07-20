import {
  consumePendingMemoryLocate,
  peekPendingMemoryLocate,
  PENDING_MEMORY_LOCATE_EVENT,
} from '@/utils/pendingMemoryLocate';
/**
 * MemoryView - VFS Memory 管理视图
 *
 * ★ 2026-01：集成到 Learning Hub
 * ★ 2026-02：内联预览 + 跳转编辑器，移除编辑对话框
 * ★ 2026-07：全面内联化改造
 *   - 移除全部模态框（创建根目录 / 选择根目录均改为内联面板）
 *   - 拆分 loading 状态（列表 / 变更操作分离），请求序号防竞态
 *   - 删除改为行内二次确认，面板展开加入 disclosure 动效
 *   - 列表分页加载、键盘可达性、定位链路修复（peek → ready → consume）
 *
 * 功能：
 * 1. 显示记忆列表（基于 VFS 笔记）
 * 2. 搜索记忆
 * 3. 创建/编辑/删除记忆
 * 4. 配置记忆根文件夹
 * 5. 内联展开预览，点击跳转到笔记编辑器
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  MagnifyingGlass,
  Plus,
  Trash,
  ArrowSquareOut,
  FolderOpen,
  ArrowClockwise,
  Gear,
  FileText,
  CircleNotch,
  WarningCircle,
  CaretRight,
  Download,
  CheckSquare,
  Square,
  PencilSimple,
  FloppyDisk,
  X,
  Star,
  Clock,
  Archive,
  ClockCounterClockwise,
  CheckCircle,
  XCircle,
  Lightning,
  Robot,
  User,
  BookOpen,
  List,
  GitBranch,
  Folder,
  ListPlus,
  Sparkle,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/shad/Select';
import { MemoryIcon } from '../icons/ResourceIcons';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useDisclosureMotion } from '@/features/chat/hooks/useDisclosureMotion';
import {
  getMemoryConfig,
  setMemoryRootFolder,
  createMemoryRootFolder,
  searchMemory,
  readMemory,
  writeMemorySmart,
  writeMemoryBatch,
  listMemory,
  deleteMemory,
  restoreStaleMemory,
  restoreArchivedMemory,
  updateMemoryById,
  exportAllMemories,
  getMemoryProfile,
  getMemoryAuditLogs,
  setMemoryAutoExtractFrequency,
  getMemoryTree,
  type AutoExtractFrequency,
  type MemoryConfig,
  type MemoryListItem,
  type MemorySearchResult,
  type MemoryReadOutput,
  type MemoryProfileSection,
  type MemoryAuditLogItem,
  type FolderTreeNode,
  type MemoryTypeValue,
  type MemoryPurposeType,
  batchDeleteMemories,
} from '@/api/memoryApi';
import { folderApi } from '@/dstu';
import type { FolderTreeNode as DstuFolderTreeNode } from '@/dstu/types/folder';
import type { ResourceListItem } from '../types';
import { registerMemoryDomainRefresh } from './memoryDomainRefresh';

// ============================================================================
// 常量与类型定义
// ============================================================================

const AUDIT_LOG_PAGE_SIZE = 30;
const LIST_PAGE_SIZE = 100;
/** 行内删除确认的自动复位时间 */
const DELETE_CONFIRM_TIMEOUT_MS = 3000;

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
  const disclosureMotion = useDisclosureMotion();

  // ========== 状态 ==========
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [memories, setMemories] = useState<MemoryListItem[]>([]);
  const [hasMoreMemories, setHasMoreMemories] = useState(false);
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  // ★ loading 拆分：列表加载 / 搜索 / 变更类操作互不干扰
  const [isListLoading, setIsListLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 内联表单状态
  const [isCreatingInline, setIsCreatingInline] = useState(false);
  const [showCreateRootForm, setShowCreateRootForm] = useState(false);

  // 文件夹列表（用于选择根文件夹）
  const [folderList, setFolderList] = useState<Array<{ id: string; title: string }>>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  // ★ 内联根目录选择面板（原为模态框）
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');

  // ★ 画像状态
  const [profileSections, setProfileSections] = useState<MemoryProfileSection[]>([]);
  const [showProfile, setShowProfile] = useState(false);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  // ★ 内联展开状态
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | null>(null);
  const [expandedContent, setExpandedContent] = useState<MemoryReadOutput | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  // 创建记忆状态
  const [newMemoryTitle, setNewMemoryTitle] = useState('');
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [newMemoryType, setNewMemoryType] = useState<MemoryTypeValue>('study');
  const [newMemoryPurpose, setNewMemoryPurpose] = useState<MemoryPurposeType>('memorized');
  const [isBatchImporting, setIsBatchImporting] = useState(false);
  const [batchImportText, setBatchImportText] = useState('');
  const [batchImportType, setBatchImportType] = useState<MemoryTypeValue>('study');
  const [batchImportPurpose, setBatchImportPurpose] = useState<MemoryPurposeType>('memorized');
  const [newRootFolderTitle, setNewRootFolderTitle] = useState('');

  // ★ 批量选择状态
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ★ 行内删除二次确认（替代阻塞式 confirm）
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);
  const deleteConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ★ 内联编辑状态
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  // ★ 树状视图状态
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list');
  const [treeData, setTreeData] = useState<FolderTreeNode | null>(null);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // ★ 审计日志状态
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [auditLogs, setAuditLogs] = useState<MemoryAuditLogItem[]>([]);
  const [isLoadingAuditLog, setIsLoadingAuditLog] = useState(false);
  const [hasMoreAuditLogs, setHasMoreAuditLogs] = useState(false);
  // ★ Radix Select 不允许空字符串 value，使用 'all' 作为“无筛选”哨兵值
  const [auditSourceFilter, setAuditSourceFilter] = useState<string>('all');
  const [auditSuccessFilter, setAuditSuccessFilter] = useState<string>('all');
  const [auditLoadError, setAuditLoadError] = useState<string | null>(null);

  // ========== 请求序号（防止慢响应覆盖新状态） ==========
  const listReqIdRef = useRef(0);
  const treeReqIdRef = useRef(0);
  const searchReqIdRef = useRef(0);
  const expandReqIdRef = useRef(0);
  const auditReqIdRef = useRef(0);
  const profileReqIdRef = useRef(0);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);

  // ========== 加载配置和记忆列表 ==========
  const loadConfig = useCallback(async () => {
    try {
      const cfg = await getMemoryConfig();
      setConfig(cfg);
      setLoadError(null);
    } catch (error: unknown) {
      console.error('[MemoryView] Failed to load config:', error);
      const errorMsg = t('memory.config_load_error');
      setLoadError(errorMsg);
    }
  }, [t]);

  const loadMemories = useCallback(async () => {
    if (!config?.memoryRootFolderId) return;

    const reqId = ++listReqIdRef.current;
    setIsListLoading(true);
    try {
      const items = await listMemory(undefined, LIST_PAGE_SIZE, 0);
      if (reqId !== listReqIdRef.current) return;
      setMemories(items);
      setHasMoreMemories(items.length >= LIST_PAGE_SIZE);
      setLoadError(null);
    } catch (error: unknown) {
      if (reqId !== listReqIdRef.current) return;
      console.error('[MemoryView] Failed to load memories:', error);
      const errorMsg = t('memory.load_error');
      setLoadError(errorMsg);
    } finally {
      if (reqId === listReqIdRef.current) {
        setIsListLoading(false);
      }
    }
  }, [config?.memoryRootFolderId, t]);

  // ★ 分页加载更多（原实现硬截断 100 条且无提示）
  const handleLoadMoreMemories = useCallback(async () => {
    if (!config?.memoryRootFolderId || isLoadingMore) return;
    const reqId = listReqIdRef.current;
    setIsLoadingMore(true);
    try {
      const items = await listMemory(undefined, LIST_PAGE_SIZE, memories.length);
      if (reqId !== listReqIdRef.current) return;
      setMemories(prev => {
        const seen = new Set(prev.map(m => m.id));
        return [...prev, ...items.filter(item => !seen.has(item.id))];
      });
      setHasMoreMemories(items.length >= LIST_PAGE_SIZE);
    } catch (error: unknown) {
      console.error('[MemoryView] Failed to load more memories:', error);
      showGlobalNotification('error', t('memory.load_error'));
    } finally {
      setIsLoadingMore(false);
    }
  }, [config?.memoryRootFolderId, isLoadingMore, memories.length, t]);

  const loadTree = useCallback(async () => {
    if (!config?.memoryRootFolderId) return;
    const reqId = ++treeReqIdRef.current;
    setIsLoadingTree(true);
    try {
      const tree = await getMemoryTree();
      if (reqId !== treeReqIdRef.current) return;
      setTreeData(tree);
      setTreeError(null);
    } catch (error: unknown) {
      if (reqId !== treeReqIdRef.current) return;
      console.error('[MemoryView] Failed to load tree:', error);
      setTreeError(t('memory.tree_load_error'));
    } finally {
      if (reqId === treeReqIdRef.current) {
        setIsLoadingTree(false);
      }
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

  useEffect(() => {
    if (config?.memoryRootFolderId && viewMode === 'tree') {
      loadTree();
    }
  }, [config?.memoryRootFolderId, viewMode, loadTree]);

  // ★ 域事件刷新：树视图未激活时跳过树刷新，避免无谓请求
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const refreshTreeIfVisible = useCallback(() => {
    if (viewModeRef.current === 'tree') {
      return loadTree();
    }
    return Promise.resolve();
  }, [loadTree]);

  useEffect(
    () => registerMemoryDomainRefresh(loadMemories, refreshTreeIfVisible),
    [loadMemories, refreshTreeIfVisible],
  );

  useEffect(() => {
    if (newMemoryType !== 'fact' && newMemoryPurpose === 'systemic') {
      setNewMemoryPurpose('memorized');
    }
  }, [newMemoryType, newMemoryPurpose]);

  useEffect(() => {
    if (batchImportType !== 'fact' && batchImportPurpose === 'systemic') {
      setBatchImportPurpose('memorized');
    }
  }, [batchImportType, batchImportPurpose]);

  useEffect(() => () => {
    if (deleteConfirmTimerRef.current) {
      clearTimeout(deleteConfirmTimerRef.current);
    }
  }, []);

  // ========== 搜索 ==========
  const viewModeBeforeSearch = useRef<'list' | 'tree'>('list');
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      searchReqIdRef.current++;
      setIsSearchMode(false);
      setSearchResults([]);
      return;
    }

    if (!isSearchMode) {
      viewModeBeforeSearch.current = viewMode;
    }
    const reqId = ++searchReqIdRef.current;
    setIsSearching(true);
    setIsSearchMode(true);
    setViewMode('list');
    try {
      const results = await searchMemory(searchQuery, 20);
      if (reqId !== searchReqIdRef.current) return;
      setSearchResults(results);
    } catch (error: unknown) {
      if (reqId !== searchReqIdRef.current) return;
      console.error('[MemoryView] Search failed:', error);
      setSearchResults([]);
      showGlobalNotification('error', t('memory.search_error'));
    } finally {
      if (reqId === searchReqIdRef.current) {
        setIsSearching(false);
      }
    }
  }, [searchQuery, isSearchMode, viewMode, t]);

  const handleClearSearch = useCallback(() => {
    searchReqIdRef.current++; // 使在途搜索请求失效
    setSearchQuery('');
    setIsSearchMode(false);
    setSearchResults([]);
    setViewMode(viewModeBeforeSearch.current);
  }, []);

  // ========== 创建记忆 ==========
  const handleCreateMemory = useCallback(async () => {
    if (!newMemoryTitle.trim() || !newMemoryContent.trim()) {
      showGlobalNotification('error', t('memory.empty_content'));
      return;
    }

    setIsMutating(true);
    try {
      const purposeArg = newMemoryPurpose !== 'memorized' ? newMemoryPurpose : undefined;
      const result = await writeMemorySmart(newMemoryTitle, newMemoryContent, undefined, newMemoryType, purposeArg);
      let msg: string;
      let level: 'success' | 'warning' = 'success';
      const writeSucceeded = result.event === 'ADD' || result.event === 'UPDATE' || result.event === 'APPEND' || result.event === 'DELETE';
      if (result.downgraded) {
        msg = t('memory.create_downgraded');
        level = 'warning';
      } else if (result.event === 'FILTERED') {
        msg = result.reason || t('memory.create_filtered');
        level = 'warning';
      } else if (result.event === 'NONE') {
        msg = t('memory.create_already_exists');
        level = 'warning';
      } else {
        msg = t('memory.create_success');
      }
      showGlobalNotification(level, msg);
      if (writeSucceeded) {
        setIsCreatingInline(false);
        setNewMemoryTitle('');
        setNewMemoryContent('');
        setNewMemoryType('study');
        setNewMemoryPurpose('memorized');
        loadMemories();
      }
    } catch (error: unknown) {
      console.error('[MemoryView] Create failed:', error);
      showGlobalNotification('error', t('memory.create_error'));
    } finally {
      setIsMutating(false);
    }
  }, [newMemoryTitle, newMemoryContent, newMemoryType, newMemoryPurpose, t, loadMemories]);

  const handleCancelCreate = useCallback(() => {
    setIsCreatingInline(false);
    setNewMemoryTitle('');
    setNewMemoryContent('');
    setNewMemoryType('study');
    setNewMemoryPurpose('memorized');
  }, []);

  const handleCancelBatchImport = useCallback(() => {
    setIsBatchImporting(false);
    setBatchImportText('');
    setBatchImportType('study');
    setBatchImportPurpose('memorized');
  }, []);

  // ★ 创建与批量导入互斥展开
  const handleOpenCreate = useCallback(() => {
    setIsBatchImporting(false);
    setIsCreatingInline(true);
  }, []);

  const handleOpenBatchImport = useCallback(() => {
    setIsCreatingInline(false);
    setIsBatchImporting(true);
  }, []);

  const parseBatchImportItems = useCallback((raw: string) => {
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separators = ['\t', ' | ', '｜', '：', ':'];
        for (const separator of separators) {
          const index = line.indexOf(separator);
          if (index > 0) {
            const title = line.slice(0, index).trim();
            const content = line.slice(index + separator.length).trim();
            if (title && content) {
              return { title, content };
            }
          }
        }
        return { title: line, content: line };
      });
  }, []);

  const handleBatchImport = useCallback(async () => {
    const items = parseBatchImportItems(batchImportText);
    if (items.length === 0) {
      showGlobalNotification('error', t('memory.batch_import_empty'));
      return;
    }

    setIsMutating(true);
    try {
      const purposeArg = batchImportPurpose !== 'memorized' ? batchImportPurpose : undefined;
      const result = await writeMemoryBatch(
        items.map((item) => ({
          ...item,
          memoryType: batchImportType,
          memoryPurpose: purposeArg,
        })),
        undefined,
        batchImportType,
        purposeArg,
      );

      const summary = t(
        'memory.batch_import_summary', {
          total: result.total,
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
          filtered: result.filtered,
        }
      );
      showGlobalNotification(result.filtered > 0 ? 'warning' : 'success', summary);
      if (result.added + result.updated > 0) {
        handleCancelBatchImport();
        loadMemories();
      }
    } catch (error: unknown) {
      console.error('[MemoryView] Batch import failed:', error);
      showGlobalNotification('error', t('memory.batch_import_error'));
    } finally {
      setIsMutating(false);
    }
  }, [batchImportPurpose, batchImportText, batchImportType, handleCancelBatchImport, loadMemories, parseBatchImportItems, t]);

  // ========== 内联展开预览 ==========
  const handleToggleExpand = useCallback(async (noteId: string) => {
    // 如果已经展开，则收起
    if (expandedMemoryId === noteId) {
      expandReqIdRef.current++;
      setExpandedMemoryId(null);
      setExpandedContent(null);
      return;
    }

    const reqId = ++expandReqIdRef.current;
    setExpandedMemoryId(noteId);
    setExpandedContent(null);
    setIsLoadingContent(true);
    try {
      const memory = await readMemory(noteId);
      if (reqId !== expandReqIdRef.current) return;
      if (memory) {
        setExpandedContent(memory);
      } else {
        showGlobalNotification(
          'warning',
          t('memory.read_not_found')
        );
        setExpandedMemoryId(null);
      }
    } catch (error: unknown) {
      if (reqId !== expandReqIdRef.current) return;
      console.error('[MemoryView] Read failed:', error);
      showGlobalNotification('error', t('memory.read_error'));
      setExpandedMemoryId(null);
    } finally {
      if (reqId === expandReqIdRef.current) {
        setIsLoadingContent(false);
      }
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

  // ========== 定位链路（聊天来源面板 → 展开对应记忆并滚动到可见区） ==========
  const locateMemory = useCallback((memoryId: string) => {
    // 已展开时不再 toggle（否则定位反而会把目标收起）
    if (expandedMemoryId !== memoryId) {
      handleToggleExpand(memoryId);
    }
    // 展开后滚动到目标行（等待渲染完成）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const host = scrollHostRef.current;
        const row = host?.querySelector<HTMLElement>(`[data-memory-row="${CSS.escape(memoryId)}"]`);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });
  }, [handleToggleExpand, expandedMemoryId]);

  const locateMemoryRef = useRef(locateMemory);
  locateMemoryRef.current = locateMemory;

  // ★ 修复：先 peek 确认 config 就绪后再 consume，避免未就绪时把定位 ID 丢弃；
  //   同时监听 setPendingMemoryLocate 派发的事件，支持视图已挂载时的再次定位。
  useEffect(() => {
    if (!config) return;

    const tryConsume = () => {
      if (!peekPendingMemoryLocate()) return;
      if (!config.memoryRootFolderId) {
        consumePendingMemoryLocate();
        showGlobalNotification('warning', t('memory.locate_requires_root'));
        return;
      }
      const locateId = consumePendingMemoryLocate();
      if (locateId) {
        locateMemoryRef.current(locateId);
      }
    };

    tryConsume();
    window.addEventListener(PENDING_MEMORY_LOCATE_EVENT, tryConsume);
    return () => window.removeEventListener(PENDING_MEMORY_LOCATE_EVENT, tryConsume);
  }, [config, t]);

  // ========== 删除记忆（行内二次确认，替代阻塞式 confirm） ==========
  const armDeleteConfirm = useCallback((noteId: string) => {
    setConfirmingDeleteId(noteId);
    if (deleteConfirmTimerRef.current) clearTimeout(deleteConfirmTimerRef.current);
    deleteConfirmTimerRef.current = setTimeout(() => {
      setConfirmingDeleteId(null);
    }, DELETE_CONFIRM_TIMEOUT_MS);
  }, []);

  const executeDeleteMemory = useCallback(async (noteId: string) => {
    if (deleteConfirmTimerRef.current) clearTimeout(deleteConfirmTimerRef.current);
    setConfirmingDeleteId(null);
    setIsMutating(true);
    try {
      await deleteMemory(noteId);
      showGlobalNotification('success', t('memory.delete_success'));
      // 如果正在展开的记忆被删除，收起展开
      if (expandedMemoryId === noteId) {
        setExpandedMemoryId(null);
        setExpandedContent(null);
      }
      loadMemories();
      if (isSearchMode) {
        setSearchResults(prev => prev.filter(r => r.noteId !== noteId));
      }
    } catch (error: unknown) {
      console.error('[MemoryView] Delete failed:', error);
      showGlobalNotification('error', t('memory.delete_error'));
    } finally {
      setIsMutating(false);
    }
  }, [t, loadMemories, expandedMemoryId, isSearchMode]);

  /** 第一次点击进入确认态，确认态内再次点击执行删除 */
  const handleDeleteMemory = useCallback((noteId: string) => {
    if (confirmingDeleteId === noteId) {
      executeDeleteMemory(noteId);
    } else {
      armDeleteConfirm(noteId);
    }
  }, [confirmingDeleteId, executeDeleteMemory, armDeleteConfirm]);

  // ========== 恢复过时记忆（摘除 _stale 标记） ==========
  const handleRestoreStale = useCallback(async (noteId: string) => {
    setIsMutating(true);
    try {
      const restored = await restoreStaleMemory(noteId);
      showGlobalNotification('success', t(restored ? 'memory.restore_success' : 'memory.restore_not_needed'));
      // 乐观更新：立即摘除本地列表的 stale 标记，避免等整页刷新
      setMemories(prev => prev.map(m => (m.id === noteId ? { ...m, isStale: false } : m)));
    } catch (error: unknown) {
      console.error('[MemoryView] Restore stale failed:', error);
      showGlobalNotification('error', t('memory.restore_error'));
    } finally {
      setIsMutating(false);
    }
  }, [t]);

  // ========== 恢复已归档记忆（摘除 _archived 并重建索引） ==========
  const handleRestoreArchived = useCallback(async (noteId: string) => {
    setIsMutating(true);
    try {
      const restored = await restoreArchivedMemory(noteId);
      showGlobalNotification('success', t(restored ? 'memory.restore_success' : 'memory.restore_not_needed'));
      // 乐观更新：归档恢复连带摘除过时标记（与后端 restore_archived 一致）
      setMemories(prev => prev.map(m => (m.id === noteId ? { ...m, isArchived: false, isStale: false } : m)));
    } catch (error: unknown) {
      console.error('[MemoryView] Restore archived failed:', error);
      showGlobalNotification('error', t('memory.restore_error'));
    } finally {
      setIsMutating(false);
    }
  }, [t]);

  // ========== 批量删除（行内二次确认） ==========
  const executeBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setConfirmingBatchDelete(false);
    setIsMutating(true);
    try {
      const result = await batchDeleteMemories(Array.from(selectedIds));
      if (result.failed > 0) {
        showGlobalNotification('warning', t('memory.batch_delete_partial', { succeeded: result.succeeded, failed: result.failed }));
      } else {
        showGlobalNotification('success', t('memory.batch_delete_success', { count: result.succeeded }));
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
      showGlobalNotification('error', t('memory.batch_delete_error'));
    } finally {
      setIsMutating(false);
    }
  }, [selectedIds, t, loadMemories, expandedMemoryId]);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    if (confirmingBatchDelete) {
      executeBatchDelete();
    } else {
      setConfirmingBatchDelete(true);
      if (deleteConfirmTimerRef.current) clearTimeout(deleteConfirmTimerRef.current);
      deleteConfirmTimerRef.current = setTimeout(() => {
        setConfirmingBatchDelete(false);
      }, DELETE_CONFIRM_TIMEOUT_MS);
    }
  }, [selectedIds.size, confirmingBatchDelete, executeBatchDelete]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ★ 全选基于当前可见集合（搜索模式下选搜索结果，而非底层列表）
  const visibleIds = useMemo(
    () => (isSearchMode ? searchResults.map(r => r.noteId) : memories.map(m => m.id)),
    [isSearchMode, searchResults, memories],
  );

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === visibleIds.length && visibleIds.length > 0) {
        return new Set();
      }
      return new Set(visibleIds);
    });
  }, [visibleIds]);

  // ========== 导出记忆 ==========
  const handleExportMemories = useCallback(async () => {
    setIsMutating(true);
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
    } catch (error: unknown) {
      console.error('[MemoryView] Export failed:', error);
      showGlobalNotification('error', t('memory.export_error'));
    } finally {
      setIsMutating(false);
    }
  }, [t]);

  // ========== 内联编辑 ==========
  const handleStartEdit = useCallback((noteId: string, content: string) => {
    setEditingMemoryId(noteId);
    setEditContent(content);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingMemoryId) return;
    setIsMutating(true);
    try {
      await updateMemoryById(editingMemoryId, undefined, editContent);
      showGlobalNotification('success', t('memory.edit_success'));
      setEditingMemoryId(null);
      setEditContent('');
      if (expandedMemoryId === editingMemoryId) {
        const updated = await readMemory(editingMemoryId);
        if (updated) setExpandedContent(updated);
      }
      loadMemories();
    } catch (error: unknown) {
      console.error('[MemoryView] Edit failed:', error);
      showGlobalNotification('error', t('memory.edit_error'));
    } finally {
      setIsMutating(false);
    }
  }, [editingMemoryId, editContent, t, expandedMemoryId, loadMemories]);

  const handleCancelEdit = useCallback(() => {
    setEditingMemoryId(null);
    setEditContent('');
  }, []);

  // 归档记忆沉底展示（稳定分区，组内保持后端返回的 updated_at DESC 顺序）
  const displayMemories = useMemo(() => {
    if (!memories.some(m => m.isArchived)) return memories;
    return [...memories.filter(m => !m.isArchived), ...memories.filter(m => m.isArchived)];
  }, [memories]);

  // ★ 性能：树状视图的 note 元数据映射与折叠回调保持稳定引用，
  // 避免每次渲染都重建导致 MemoryTreeNode 的 React.memo 失效
  const noteTitleMap = useMemo(() => {
    const map: Record<string, NoteMetaInfo> = {};
    for (const m of memories) {
      map[m.id] = { title: m.title, memoryType: m.memoryType, memoryPurpose: m.memoryPurpose, isImportant: m.isImportant, isStale: m.isStale };
    }
    return map;
  }, [memories]);

  const handleToggleFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  }, []);

  // ========== 加载画像 ==========
  const handleToggleProfile = useCallback(async () => {
    if (showProfile) {
      setShowProfile(false);
      return;
    }
    const reqId = ++profileReqIdRef.current;
    setIsLoadingProfile(true);
    setShowProfile(true);
    setShowAuditLog(false);
    setProfileError(null);
    try {
      const sections = await getMemoryProfile();
      if (reqId !== profileReqIdRef.current) return;
      setProfileSections(sections);
    } catch (error: unknown) {
      if (reqId !== profileReqIdRef.current) return;
      console.error('[MemoryView] Load profile failed:', error);
      setProfileSections([]);
      setProfileError(t('memory.profile_load_error'));
    } finally {
      if (reqId === profileReqIdRef.current) {
        setIsLoadingProfile(false);
      }
    }
  }, [showProfile, t]);

  // ========== 审计日志 ==========
  // ★ 显式传 offset + 请求序号，消除“offset effect 链”带来的重复追加与筛选竞态
  const loadAuditLogs = useCallback(async (offset: number) => {
    const reqId = ++auditReqIdRef.current;
    setIsLoadingAuditLog(true);
    try {
      const logs = await getMemoryAuditLogs({
        limit: AUDIT_LOG_PAGE_SIZE,
        offset,
        sourceFilter: auditSourceFilter === 'all' ? undefined : auditSourceFilter,
        successFilter: auditSuccessFilter === 'all' ? undefined : auditSuccessFilter === 'true',
      });
      if (reqId !== auditReqIdRef.current) return;
      setAuditLoadError(null);
      setHasMoreAuditLogs(logs.length >= AUDIT_LOG_PAGE_SIZE);
      if (offset === 0) {
        setAuditLogs(logs);
      } else {
        setAuditLogs(prev => {
          const seen = new Set(prev.map(l => l.id));
          return [...prev, ...logs.filter(l => !seen.has(l.id))];
        });
      }
    } catch (error: unknown) {
      if (reqId !== auditReqIdRef.current) return;
      console.error('[MemoryView] Load audit logs failed:', error);
      const msg = t('memory.audit_load_error');
      setAuditLoadError(msg);
      showGlobalNotification('error', msg);
    } finally {
      if (reqId === auditReqIdRef.current) {
        setIsLoadingAuditLog(false);
      }
    }
  }, [auditSourceFilter, auditSuccessFilter, t]);

  const handleToggleAuditLog = useCallback(() => {
    if (showAuditLog) {
      setShowAuditLog(false);
      return;
    }
    setShowAuditLog(true);
    setShowProfile(false);
    loadAuditLogs(0);
  }, [showAuditLog, loadAuditLogs]);

  const handleLoadMoreLogs = useCallback(() => {
    loadAuditLogs(auditLogs.length);
  }, [loadAuditLogs, auditLogs.length]);

  // 筛选变更时重新加载第一页（面板打开时）
  const isFirstAuditFilterRender = useRef(true);
  useEffect(() => {
    if (isFirstAuditFilterRender.current) {
      isFirstAuditFilterRender.current = false;
      return;
    }
    if (showAuditLog) {
      loadAuditLogs(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditSourceFilter, auditSuccessFilter]);

  // ========== 加载文件夹列表 ==========
  const loadFolders = useCallback(async (): Promise<boolean> => {
    setLoadingFolders(true);
    try {
      const treeResult = await folderApi.getFolderTree();
      if (!treeResult.ok) {
        console.error('[MemoryView] Load folders failed:', treeResult.error);
        showGlobalNotification(
          'error',
          t('memory.folder_load_error')
        );
        return false;
      }
      const tree = treeResult.value;
      // 扁平化文件夹树
      const folders: Array<{ id: string; title: string }> = [];
      const flatten = (nodes: DstuFolderTreeNode[], prefix = '') => {
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
      return true;
    } catch (error: unknown) {
      console.error('[MemoryView] Load folders failed:', error);
      showGlobalNotification(
        'error',
        t('memory.folder_load_error')
      );
      return false;
    } finally {
      setLoadingFolders(false);
    }
  }, [t]);

  // ★ 主视图的“更改根目录”：加载文件夹后展开内联选择面板（原为模态框）
  const handleOpenRootPicker = useCallback(async () => {
    if (isPickerOpen) {
      setIsPickerOpen(false);
      return;
    }
    const ok = await loadFolders();
    if (ok) {
      setPickerFilter('');
      setIsPickerOpen(true);
    }
  }, [isPickerOpen, loadFolders]);

  // ========== 自动提取频率 ==========
  const handleFrequencyChange = useCallback(async (freq: AutoExtractFrequency) => {
    if (config?.autoExtractFrequency === freq) return;
    try {
      await setMemoryAutoExtractFrequency(freq);
      loadConfig();
      showGlobalNotification('success', t('memory.frequency_changed'));
    } catch (error: unknown) {
      console.error('[MemoryView] Set frequency failed:', error);
      showGlobalNotification('error', t('memory.frequency_change_error'));
    }
  }, [t, loadConfig, config?.autoExtractFrequency]);

  // ========== 设置根文件夹 ==========
  const handleSelectRootFolder = useCallback(async (folderId: string) => {
    try {
      await setMemoryRootFolder(folderId);
      showGlobalNotification('success', t('memory.root_set_success'));
      setIsPickerOpen(false);
      loadConfig();
    } catch (error: unknown) {
      console.error('[MemoryView] Set root folder failed:', error);
      showGlobalNotification('error', t('memory.root_set_error'));
    }
  }, [t, loadConfig]);

  const handleCreateRootFolder = useCallback(async () => {
    if (!newRootFolderTitle.trim()) {
      showGlobalNotification('error', t('memory.empty_folder_title'));
      return;
    }

    setIsMutating(true);
    try {
      await createMemoryRootFolder(newRootFolderTitle);
      showGlobalNotification('success', t('memory.root_create_success'));
      setShowCreateRootForm(false);
      setNewRootFolderTitle('');
      loadConfig();
    } catch (error: unknown) {
      console.error('[MemoryView] Create root folder failed:', error);
      showGlobalNotification('error', t('memory.root_create_error'));
    } finally {
      setIsMutating(false);
    }
  }, [newRootFolderTitle, t, loadConfig]);

  // ★ 统计栏数据（原实现每次渲染 IIFE + 重复 filter）
  const memoryStats = useMemo(() => {
    const purposeCounts: Record<string, number> = {};
    let importantCount = 0;
    for (const m of memories) {
      const p = m.memoryPurpose || 'memorized';
      purposeCounts[p] = (purposeCounts[p] || 0) + 1;
      if (m.isImportant) importantCount++;
    }
    return { purposeCounts, importantCount };
  }, [memories]);

  const filteredFolderList = useMemo(() => {
    const q = pickerFilter.trim().toLowerCase();
    if (!q) return folderList;
    return folderList.filter(f => f.title.toLowerCase().includes(q));
  }, [folderList, pickerFilter]);

  // ========== 渲染：配置加载失败 - 内嵌错误态 ==========
  if (loadError && !config) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full p-8', className)}>
        <WarningCircle size={48} className="text-destructive/60 mb-4" />
        <h2 className="text-lg font-medium mb-1.5">
          {t('memory.load_error_title')}
        </h2>
        <p className="text-sm text-muted-foreground text-center mb-6 max-w-sm">
          {loadError}
        </p>
        <NotionButton
          variant="primary"
          size="md"
          onClick={loadConfig}
        >
          <ArrowClockwise className="w-4 h-4" />
          {t('common:retry')}
        </NotionButton>
      </div>
    );
  }

  // ========== 渲染：未配置根文件夹 - Notion 风格（全内联，无模态框） ==========
  if (!config?.memoryRootFolderId) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full p-8', className)}>
        <MemoryIcon size={48} className="text-muted-foreground/40 mb-4" />
        <h2 className="text-lg font-medium mb-1.5">
          {t('memory.setup_title')}
        </h2>
        <p className="text-sm text-muted-foreground text-center mb-6 max-w-sm">
          {t('memory.setup_description')}
        </p>

        {/* 文件夹列表 */}
        {folderList.length > 0 ? (
          <div className="w-full max-w-sm mb-4">
            <p className="text-xs text-muted-foreground mb-2">{t('memory.select_folder')}:</p>
            <CustomScrollArea className="rounded-lg bg-muted/30 max-h-40">
              <div className="p-1">
                {folderList.map((folder) => (
                  <NotionButton
                    key={folder.id}
                    variant="ghost" size="sm"
                    className="w-full !justify-start !px-3 !py-2"
                    onClick={() => handleSelectRootFolder(folder.id)}
                  >
                    <FolderOpen size={14} className="text-muted-foreground" />
                    <span className="truncate">{folder.title}</span>
                  </NotionButton>
                ))}
              </div>
            </CustomScrollArea>
          </div>
        ) : (
          <NotionButton variant="ghost" size="sm" onClick={loadFolders} disabled={loadingFolders} className="mb-4">
            {loadingFolders ? (
              <CircleNotch size={16} className="animate-spin" />
            ) : (
              <FolderOpen size={16} />
            )}
            {t('memory.select_folder')}
          </NotionButton>
        )}

        <div className="text-xs text-muted-foreground/60 mb-3">{t('learningHub:memory.or')}</div>

        {/* ★ 内联创建根文件夹表单（原为模态框） */}
        <AnimatePresence initial={false} mode="wait">
          {showCreateRootForm ? (
            <motion.div key="create-root-form" {...disclosureMotion} className="w-full max-w-sm overflow-hidden">
              <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-card/60 p-3 space-y-2.5 shadow-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <FolderOpen size={14} />
                  <span className="text-xs font-medium">{t('memory.create_root_title')}</span>
                </div>
                <Input
                  placeholder={t('memory.folder_name_placeholder')}
                  value={newRootFolderTitle}
                  onChange={(e) => setNewRootFolderTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newRootFolderTitle.trim() && !isMutating) {
                      e.preventDefault();
                      handleCreateRootFolder();
                    } else if (e.key === 'Escape') {
                      setShowCreateRootForm(false);
                      setNewRootFolderTitle('');
                    }
                  }}
                  autoFocus
                  className="w-full h-9 bg-muted/30 border-transparent rounded-md focus-visible:border-border focus-visible:bg-background"
                />
                <div className="flex gap-2">
                  <NotionButton variant="ghost" size="sm" className="flex-1" onClick={() => { setShowCreateRootForm(false); setNewRootFolderTitle(''); }}>
                    {t('common:cancel')}
                  </NotionButton>
                  <NotionButton variant="primary" size="sm" className="flex-1" onClick={handleCreateRootFolder} disabled={isMutating || !newRootFolderTitle.trim()}>
                    {isMutating && <CircleNotch size={16} className="animate-spin" />}
                    {t('common:create')}
                  </NotionButton>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div key="create-root-button" {...disclosureMotion} className="overflow-hidden">
              <NotionButton variant="ghost" size="sm" onClick={() => setShowCreateRootForm(true)} className="text-primary hover:bg-primary/10">
                <Plus size={16} />
                {t('memory.create_folder')}
              </NotionButton>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  // ========== 渲染：主视图 ==========
  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 顶部工具栏 - Notion 风格（窄容器允许折行，避免单行溢出） */}
      <div data-wb-blur-surface className="flex flex-wrap items-center gap-2 gap-y-1.5 px-4 py-3 border-b border-black/[0.06] dark:border-white/[0.08] bg-background/80 backdrop-blur-xl">
        {/* 搜索框：保留最小可用宽度，不足时让后续按钮折行 */}
        <div className="flex-1 min-w-[9rem] relative">
          <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" size={16} />
          <Input
            type="search"
            placeholder={t('memory.search_placeholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
              else if (e.key === 'Escape' && searchQuery) handleClearSearch();
            }}
            className="w-full h-9 pl-9 pr-8 bg-muted/30 border-transparent rounded-md focus-visible:border-border focus-visible:bg-background"
          />
          {isSearching ? (
            <CircleNotch size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground/60" />
          ) : searchQuery ? (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleClearSearch} className="absolute right-3 top-1/2 -translate-y-1/2 !h-5 !w-5 !p-0 text-muted-foreground/60 hover:text-foreground" aria-label={t('memory.aria.clear_search')}>
              ×
            </NotionButton>
          ) : null}
        </div>

        {/* 视图切换 */}
        <NotionButton variant="ghost" size="icon" iconOnly onClick={loadMemories} disabled={isListLoading} aria-label={t('memory.aria.refresh')}>
          <ArrowClockwise className={cn('w-4 h-4', isListLoading && 'animate-spin')} />
        </NotionButton>
        <NotionButton
          variant="ghost" size="icon" iconOnly
          onClick={() => setViewMode(viewMode === 'list' ? 'tree' : 'list')}
          className={cn(viewMode === 'tree' && 'text-primary bg-primary/10')}
          aria-label={viewMode === 'tree' ? t('memory.aria.list_view') : t('memory.aria.tree_view')}
          title={viewMode === 'tree' ? t('memory.list_view') : t('memory.tree_view')}
        >
          {viewMode === 'tree' ? <List size={16} /> : <GitBranch size={16} />}
        </NotionButton>

        <div className="w-px h-5 bg-border/50" />

        {/* 操作 */}
        <NotionButton
          variant="ghost" size="icon" iconOnly
          onClick={() => { setBatchMode(!batchMode); setSelectedIds(new Set()); setConfirmingBatchDelete(false); }}
          className={cn(batchMode && 'text-primary bg-primary/10')}
          aria-label={t('memory.aria.batch')}
        >
          <CheckSquare size={16} />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleExportMemories} disabled={isMutating} aria-label={t('memory.aria.export')}>
          <Download size={16} />
        </NotionButton>

        <div className="w-px h-5 bg-border/50" />

        {/* 面板 */}
        <NotionButton
          variant="ghost" size="icon" iconOnly
          onClick={handleToggleProfile}
          className={cn(showProfile && 'text-primary bg-primary/10')}
          aria-label={t('memory.aria.profile')}
        >
          <MemoryIcon size={16} />
        </NotionButton>
        <NotionButton
          variant="ghost" size="icon" iconOnly
          onClick={handleToggleAuditLog}
          className={cn(showAuditLog && 'text-primary bg-primary/10')}
          aria-label={t('memory.aria.audit_log')}
          title={t('memory.audit_log')}
        >
          <ClockCounterClockwise size={16} />
        </NotionButton>
        {!batchMode && (
          <>
            <NotionButton
              variant="ghost" size="sm"
              onClick={isBatchImporting ? handleCancelBatchImport : handleOpenBatchImport}
              className={cn('text-success hover:bg-success/10', isBatchImporting && 'bg-success/10')}
            >
              <ListPlus size={16} />
              {t('memory.batch_import')}
            </NotionButton>
            <NotionButton
              variant="ghost" size="sm"
              onClick={isCreatingInline ? handleCancelCreate : handleOpenCreate}
              className={cn('text-primary hover:bg-primary/10', isCreatingInline && 'bg-primary/10')}
            >
              <Plus size={16} />
              {t('memory.new')}
            </NotionButton>
          </>
        )}
        {batchMode && (
          <>
            <NotionButton
              variant="ghost" size="sm"
              onClick={handleToggleSelectAll}
              className="text-muted-foreground hover:bg-[var(--interactive-hover)]"
            >
              {selectedIds.size === visibleIds.length && visibleIds.length > 0 ? t('memory.deselect_all') : t('memory.select_all')}
            </NotionButton>
            {selectedIds.size > 0 && (
              <NotionButton
                variant="ghost" size="sm"
                onClick={handleBatchDelete}
                disabled={isMutating}
                className={cn(
                  'text-danger hover:bg-danger/10 transition-colors',
                  confirmingBatchDelete && 'bg-danger/15 font-medium'
                )}
              >
                {isMutating ? <CircleNotch size={16} className="animate-spin" /> : <Trash size={16} />}
                {confirmingBatchDelete
                  ? t('memory.confirm_delete')
                  : t('memory.batch_delete', { count: selectedIds.size })}
              </NotionButton>
            )}
          </>
        )}
      </div>

      {/* 当前根文件夹 + 提取频率设置 */}
      <div className="px-4 py-2 text-xs text-muted-foreground space-y-1.5 border-b border-border/30">
        <div className="flex items-center gap-2">
          <FolderOpen size={14} />
          <span>{t('memory.root_folder')}:</span>
          <span className="font-medium text-foreground">{config.memoryRootFolderTitle || t('memory.defaultRootTitle')}</span>
          <NotionButton
            variant="ghost" size="sm"
            onClick={handleOpenRootPicker}
            disabled={loadingFolders}
            className={cn('ml-auto !h-auto !px-1.5 !py-0.5', isPickerOpen && 'bg-primary/10 text-primary')}
          >
            {loadingFolders ? (
              <CircleNotch size={12} className="animate-spin" />
            ) : (
              <Gear size={12} />
            )}
            {t('memory.change')}
          </NotionButton>
        </div>
        <div className="flex items-center gap-2">
          <Lightning size={14} />
          <span>{t('memory.auto_extract')}:</span>
          <div className="flex items-center gap-0.5 ml-1">
            {([
              { value: 'off' as const, label: t('memory.freq_off'), desc: t('memory.freq_off_desc') },
              { value: 'balanced' as const, label: t('memory.freq_balanced'), desc: t('memory.freq_balanced_desc') },
              { value: 'aggressive' as const, label: t('memory.freq_aggressive'), desc: t('memory.freq_aggressive_desc') },
            ]).map((opt) => (
              <button
                key={opt.value}
                title={opt.desc}
                onClick={() => handleFrequencyChange(opt.value)}
                className={cn(
                  'px-2 py-0.5 rounded text-[11px] transition-colors',
                  config.autoExtractFrequency === opt.value
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* ★ 内联根目录选择面板（原为模态框） */}
        <AnimatePresence initial={false}>
          {isPickerOpen && (
            <motion.div key="root-picker" {...disclosureMotion} className="overflow-hidden">
              <div className="mt-1 rounded-lg border border-border/60 bg-card/50 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30">
                  <FolderOpen size={13} className="text-muted-foreground" />
                  <span className="text-[11px] font-medium text-muted-foreground">{t('memory.select_root_folder')}</span>
                  <div className="flex-1 relative ml-1">
                    <Input
                      value={pickerFilter}
                      onChange={(e) => setPickerFilter(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Escape') setIsPickerOpen(false); }}
                      placeholder={t('memory.filter_folders')}
                      autoFocus
                      className="w-full h-6 px-2 text-[11px] bg-muted/30 border-transparent rounded focus-visible:border-border focus-visible:bg-background"
                    />
                  </div>
                  <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setIsPickerOpen(false)} className="!h-5 !w-5 !p-0" aria-label={t('common:cancel')}>
                    <X size={12} />
                  </NotionButton>
                </div>
                <CustomScrollArea className="max-h-48">
                  <div className="p-1">
                    {filteredFolderList.length === 0 ? (
                      <div className="px-3 py-3 text-[11px] text-muted-foreground/60 text-center">
                        {t('memory.no_results')}
                      </div>
                    ) : filteredFolderList.map((folder) => (
                      <NotionButton
                        key={folder.id}
                        variant="ghost" size="sm"
                        className={cn(
                          'w-full !justify-start !px-2.5 !py-1.5 text-xs',
                          folder.id === config.memoryRootFolderId && 'bg-primary/10 text-primary'
                        )}
                        onClick={() => handleSelectRootFolder(folder.id)}
                      >
                        <FolderOpen size={14} className={cn('shrink-0', folder.id === config.memoryRootFolderId ? 'text-primary' : 'text-amber-500')} />
                        <span className="truncate">{folder.title}</span>
                        {folder.id === config.memoryRootFolderId && (
                          <CheckCircle size={12} className="ml-auto shrink-0" />
                        )}
                      </NotionButton>
                    ))}
                  </div>
                </CustomScrollArea>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 统计栏 */}
      {memories.length > 0 && !isSearchMode && (
        <div className="px-4 py-1.5 text-2xs text-muted-foreground/70 border-b border-border/20 flex items-center gap-3">
          <span className="font-medium text-muted-foreground">{t('memory.count', { count: memories.length })}</span>
          {Object.entries(memoryStats.purposeCounts).map(([key, count]) => (
            <span key={key} className={cn('px-1.5 py-0 rounded', PURPOSE_BADGE_STYLES[key] || 'bg-muted')}>
              {purposeLabel(t, key)} {count}
            </span>
          ))}
          {memoryStats.importantCount > 0 && (
            <span className="flex items-center gap-0.5">
              <Star size={10} className="text-amber-500" weight="fill" />
              {memoryStats.importantCount}
            </span>
          )}
        </div>
      )}

      {/* 记忆列表 */}
      <CustomScrollArea className="flex-1">
        <div className="p-3 space-y-3" ref={scrollHostRef}>
          {/* 画像汇总 */}
          <AnimatePresence initial={false}>
            {showProfile && (
              <motion.div key="profile-panel" {...disclosureMotion} className="overflow-hidden">
                <div className="rounded-lg border border-border/60 bg-card/50 overflow-hidden">
                  <div data-wb-blur-surface className="flex items-center gap-2 px-4 py-2.5 border-b border-black/[0.05] dark:border-white/[0.07] bg-muted/25 backdrop-blur-sm">
                    <MemoryIcon size={14} className="text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">{t('memory.profile_title')}</span>
                  </div>
                  {isLoadingProfile ? (
                    <div className="flex items-center justify-center py-6">
                      <CircleNotch size={16} className="animate-spin text-muted-foreground" />
                    </div>
                  ) : profileError ? (
                    <div className="px-4 py-4 text-xs text-destructive/80 text-center space-y-2">
                      <div>{profileError}</div>
                      <NotionButton variant="ghost" size="sm" onClick={() => { setShowProfile(false); handleToggleProfile(); }} className="text-xs">
                        {t('common:retry')}
                      </NotionButton>
                    </div>
                  ) : profileSections.length === 0 ? (
                    <div className="px-4 py-4 text-xs text-muted-foreground/60 text-center">
                      {t('memory.profile_empty')}
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
              </motion.div>
            )}
          </AnimatePresence>

          {/* 审计日志面板 */}
          <AnimatePresence initial={false}>
            {showAuditLog && (
              <motion.div key="audit-panel" {...disclosureMotion} className="overflow-hidden">
                <div className="rounded-lg border border-border/60 bg-card/50 overflow-hidden">
                  <div data-wb-blur-surface className="flex items-center gap-2 px-4 py-2.5 border-b border-black/[0.05] dark:border-white/[0.07] bg-muted/25 backdrop-blur-sm">
                    <ClockCounterClockwise size={14} className="text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">{t('memory.audit_log')}</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {/* 来源筛选 */}
                      <Select value={auditSourceFilter} onValueChange={setAuditSourceFilter}>
                        <SelectTrigger className="h-6 px-1.5 text-2xs bg-muted/40 border-none rounded w-auto min-h-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{t('memory.audit_all_sources')}</SelectItem>
                          <SelectItem value="tool_call">{t('memory.audit_source_tool')}</SelectItem>
                          <SelectItem value="auto_extract">{t('memory.audit_source_auto')}</SelectItem>
                          <SelectItem value="handler">{t('memory.audit_source_handler')}</SelectItem>
                          <SelectItem value="evolution">{t('memory.audit_source_evolution')}</SelectItem>
                          <SelectItem value="semantic_dedup">{t('memory.audit_source_semantic_dedup')}</SelectItem>
                        </SelectContent>
                      </Select>
                      {/* 成功/失败筛选 */}
                      <Select value={auditSuccessFilter} onValueChange={setAuditSuccessFilter}>
                        <SelectTrigger className="h-6 px-1.5 text-2xs bg-muted/40 border-none rounded w-auto min-h-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{t('memory.audit_all_status')}</SelectItem>
                          <SelectItem value="true">{t('memory.audit_success')}</SelectItem>
                          <SelectItem value="false">{t('memory.audit_failed')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <NotionButton variant="ghost" size="icon" iconOnly onClick={() => loadAuditLogs(0)} disabled={isLoadingAuditLog} className="!h-5 !w-5 !p-0" aria-label={t('memory.aria.refresh_logs')}>
                        <ArrowClockwise className={cn('w-3 h-3', isLoadingAuditLog && 'animate-spin')} />
                      </NotionButton>
                    </div>
                  </div>
                  {isLoadingAuditLog && auditLogs.length === 0 ? (
                    <div className="flex items-center justify-center py-6">
                      <CircleNotch size={16} className="animate-spin text-muted-foreground" />
                    </div>
                  ) : auditLoadError ? (
                    <div className="px-4 py-4 text-xs text-danger text-center space-y-2">
                      <div>{auditLoadError}</div>
                      <div>
                        <NotionButton variant="ghost" size="sm" onClick={() => loadAuditLogs(0)} className="text-xs">
                          {t('common:retry')}
                        </NotionButton>
                      </div>
                    </div>
                  ) : auditLogs.length === 0 ? (
                    <div className="px-4 py-4 text-xs text-muted-foreground/60 text-center">
                      {t('memory.audit_empty')}
                    </div>
                  ) : (
                    <div>
                      <div className="divide-y divide-border/20">
                        {auditLogs.map((log) => (
                          <AuditLogRow key={log.id} log={log} />
                        ))}
                      </div>
                      {hasMoreAuditLogs && (
                        <div className="flex justify-center py-2 border-t border-border/20">
                          <NotionButton variant="ghost" size="sm" onClick={handleLoadMoreLogs} disabled={isLoadingAuditLog} className="text-xs text-muted-foreground">
                            {isLoadingAuditLog ? <CircleNotch size={12} className="animate-spin" /> : null}
                            {t('memory.audit_load_more')}
                          </NotionButton>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 批量导入表单 */}
          <AnimatePresence initial={false}>
            {isBatchImporting && (
              <motion.div key="batch-import-form" {...disclosureMotion} className="overflow-hidden">
                <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-card/60 p-4 space-y-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <ListPlus size={16} />
                      <span className="text-sm font-medium">{t('memory.batch_import')}</span>
                    </div>
                    <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCancelBatchImport} disabled={isMutating} aria-label={t('memory.aria.cancel_batch_import')}>
                      <X size={16} />
                    </NotionButton>
                  </div>

                  <div className="text-xs text-muted-foreground leading-relaxed">
                    {t('memory.batch_import_hint')}
                  </div>

                  <Textarea
                    placeholder={t('memory.batch_import_placeholder')}
                    value={batchImportText}
                    onChange={(e) => setBatchImportText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isMutating) {
                        e.preventDefault();
                        handleBatchImport();
                      }
                    }}
                    rows={8}
                    className="w-full bg-muted/30 border-transparent rounded-md resize-y focus-visible:border-border focus-visible:bg-background"
                  />

                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-xs text-muted-foreground mr-1.5">{t('memory.type')}:</span>
                    {([
                      ['fact', 'memory.type_fact'],
                      ['study', 'memory.type_study'],
                      ['note', 'memory.type_note'],
                    ] as const).map(([type, labelKey]) => (
                      <NotionButton
                        key={type}
                        variant="ghost"
                        size="sm"
                        onClick={() => setBatchImportType(type)}
                        className={cn(
                          '!h-auto !min-h-0 !px-2 !py-0.5 rounded text-[11px] transition-colors',
                          batchImportType === type
                            ? 'bg-primary/15 text-primary font-medium'
                            : 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground'
                        )}
                      >
                        {t(labelKey)}
                      </NotionButton>
                    ))}
                  </div>

                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-xs text-muted-foreground mr-1.5">{t('memory.purpose')}:</span>
                    {(batchImportType === 'fact'
                      ? (['memorized', 'internalized', 'supplementary', 'systemic'] as const)
                      : (['memorized', 'internalized', 'supplementary'] as const)).map((p) => (
                      <NotionButton
                        key={p}
                        variant="ghost"
                        size="sm"
                        onClick={() => setBatchImportPurpose(p)}
                        className={cn(
                          '!h-auto !min-h-0 !px-2 !py-0.5 rounded text-[11px] transition-colors',
                          batchImportPurpose === p
                            ? (PURPOSE_BADGE_STYLES[p] || 'bg-primary/15 text-primary') + ' font-medium'
                            : 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground'
                        )}
                      >
                        {purposeLabel(t, p)}
                      </NotionButton>
                    ))}
                  </div>

                  <div className="text-xs text-muted-foreground">
                    {t('memory.batch_import_count', { count: parseBatchImportItems(batchImportText).length })}
                  </div>

                  <div className="flex gap-2 pt-1">
                    <NotionButton variant="ghost" size="sm" onClick={handleCancelBatchImport} disabled={isMutating} className="flex-1 !h-9">
                      {t('common:cancel')}
                    </NotionButton>
                    <NotionButton variant="primary" size="sm" onClick={handleBatchImport} disabled={isMutating || parseBatchImportItems(batchImportText).length === 0} className="flex-1 !h-9">
                      {isMutating && <CircleNotch size={16} className="animate-spin" />}
                      {t('memory.batch_import_confirm')}
                    </NotionButton>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 内联创建表单 */}
          <AnimatePresence initial={false}>
            {isCreatingInline && (
              <motion.div key="create-form" {...disclosureMotion} className="overflow-hidden">
                <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-card/60 p-4 space-y-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <MemoryIcon size={16} />
                      <span className="text-sm font-medium">{t('memory.create_title')}</span>
                    </div>
                    <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCancelCreate} disabled={isMutating} aria-label={t('memory.aria.cancel')}>
                      <X size={16} />
                    </NotionButton>
                  </div>

                  <Input
                    placeholder={t('memory.title_placeholder')}
                    value={newMemoryTitle}
                    onChange={(e) => setNewMemoryTitle(e.target.value)}
                    autoFocus
                    className="w-full h-9 bg-muted/30 border-transparent rounded-md focus-visible:border-border focus-visible:bg-background"
                  />
                  <Textarea
                    placeholder={
                      newMemoryType === 'fact'
                        ? t('memory.content_placeholder_fact')
                        : newMemoryType === 'study'
                          ? t('memory.content_placeholder_study')
                          : t('memory.content_placeholder_note')
                    }
                    value={newMemoryContent}
                    onChange={(e) => setNewMemoryContent(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && newMemoryTitle.trim() && newMemoryContent.trim() && !isMutating) {
                        e.preventDefault();
                        handleCreateMemory();
                      }
                    }}
                    rows={5}
                    className="w-full bg-muted/30 border-transparent rounded-md resize-none focus-visible:border-border focus-visible:bg-background"
                  />

                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-xs text-muted-foreground mr-1.5">{t('memory.type')}:</span>
                    {([
                      ['fact', 'memory.type_fact'],
                      ['study', 'memory.type_study'],
                      ['note', 'memory.type_note'],
                    ] as const).map(([type, labelKey]) => (
                      <NotionButton
                        key={type}
                        variant="ghost"
                        size="sm"
                        onClick={() => setNewMemoryType(type)}
                        className={cn(
                          '!h-auto !min-h-0 !px-2 !py-0.5 rounded text-[11px] transition-colors',
                          newMemoryType === type
                            ? 'bg-primary/15 text-primary font-medium'
                            : 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground'
                        )}
                      >
                        {t(labelKey)}
                      </NotionButton>
                    ))}
                  </div>

                  {/* 目的分类选择 */}
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground mr-1.5">{t('memory.purpose')}:</span>
                    {(newMemoryType === 'fact'
                      ? (['memorized', 'internalized', 'supplementary', 'systemic'] as const)
                      : (['memorized', 'internalized', 'supplementary'] as const)).map((p) => (
                      <NotionButton
                        key={p}
                        variant="ghost"
                        size="sm"
                        onClick={() => setNewMemoryPurpose(p)}
                        className={cn(
                          '!h-auto !min-h-0 !px-2 !py-0.5 rounded text-[11px] transition-colors',
                          newMemoryPurpose === p
                            ? (PURPOSE_BADGE_STYLES[p] || 'bg-primary/15 text-primary') + ' font-medium'
                            : 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground'
                        )}
                      >
                        {purposeLabel(t, p)}
                      </NotionButton>
                    ))}
                  </div>

                  <div className="flex gap-2 pt-1">
                    <NotionButton variant="ghost" size="sm" onClick={handleCancelCreate} disabled={isMutating} className="flex-1 !h-9">
                      {t('common:cancel')}
                    </NotionButton>
                    <NotionButton variant="primary" size="sm" onClick={handleCreateMemory} disabled={isMutating || !newMemoryTitle.trim() || !newMemoryContent.trim()} className="flex-1 !h-9">
                      {isMutating && <CircleNotch size={16} className="animate-spin" />}
                      {t('common:create')}
                    </NotionButton>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 树状视图 */}
          {viewMode === 'tree' && !isSearchMode && (
            isLoadingTree ? (
              <div className="flex items-center justify-center h-32">
                <CircleNotch size={20} className="animate-spin text-muted-foreground" />
              </div>
            ) : treeError ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <WarningCircle size={32} className="mb-2 text-destructive/60" />
                <span className="text-sm mb-3">{treeError}</span>
                <NotionButton variant="primary" size="sm" onClick={loadTree}>
                  <ArrowClockwise className="w-3.5 h-3.5" />
                  {t('common:retry')}
                </NotionButton>
              </div>
            ) : treeData ? (
              <div className="space-y-0.5">
                <MemoryTreeNode
                  node={treeData}
                  expandedFolders={expandedFolders}
                  noteTitleMap={noteTitleMap}
                  onToggleFolder={handleToggleFolder}
                  onClickNote={handleToggleExpand}
                  onDeleteNote={handleDeleteMemory}
                  confirmingDeleteId={confirmingDeleteId}
                  onOpenInEditor={handleOpenInEditor}
                  expandedMemoryId={expandedMemoryId}
                  expandedContent={expandedContent}
                  isLoadingContent={isLoadingContent}
                  editingMemoryId={editingMemoryId}
                  editContent={editContent}
                  onEditContentChange={setEditContent}
                  onStartEdit={handleStartEdit}
                  onSaveEdit={handleSaveEdit}
                  onCancelEdit={handleCancelEdit}
                  isLoading={isMutating}
                  depth={0}
                  isRoot
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <GitBranch size={32} className="mb-2 opacity-40" />
                <span className="text-sm">{t('memory.tree_empty')}</span>
              </div>
            )
          )}

          {/* 列表内容 - Notion 风格 */}
          {viewMode === 'list' && isListLoading && memories.length === 0 && !loadError && !isSearchMode ? (
            <div className="flex items-center justify-center h-32">
              <CircleNotch size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : viewMode === 'list' && loadError && !isSearchMode ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <WarningCircle size={32} className="mb-2 text-destructive/60" />
              <span className="text-sm mb-1 text-foreground font-medium">
                {t('memory.load_error_title')}
              </span>
              <span className="text-xs mb-3 text-center max-w-xs">{loadError}</span>
              <NotionButton
                variant="primary"
                size="sm"
                onClick={loadMemories}
                disabled={isListLoading}
              >
                <ArrowClockwise className={cn('w-3.5 h-3.5', isListLoading && 'animate-spin')} />
                {t('common:retry')}
              </NotionButton>
            </div>
          ) : viewMode === 'list' && isSearchMode ? (
            // 搜索结果
            isSearching && searchResults.length === 0 ? (
              <div className="flex items-center justify-center h-32">
                <CircleNotch size={20} className="animate-spin text-muted-foreground" />
              </div>
            ) : searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <MagnifyingGlass size={32} className="mb-2 opacity-40" />
                <span className="text-sm">{t('memory.no_results')}</span>
              </div>
            ) : (
              <div className="space-y-0.5">
                {searchResults.map((result) => {
                  const isExpanded = expandedMemoryId === result.noteId;
                  const isSelected = selectedIds.has(result.noteId);
                  return (
                    <div key={result.noteId} className="rounded-lg" data-memory-row={result.noteId}>
                      <div
                        role="button"
                        tabIndex={0}
                        className={cn(
                          'group flex flex-col gap-0.5 px-3 py-2.5 rounded-lg cursor-pointer transition-colors text-left w-full',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
                          isExpanded ? 'bg-muted/50' : !isSelected && 'hover:bg-[var(--interactive-hover)]',
                          isSelected && 'bg-primary/5'
                        )}
                        onClick={() => batchMode ? toggleSelect(result.noteId) : handleToggleExpand(result.noteId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            if (batchMode) toggleSelect(result.noteId); else handleToggleExpand(result.noteId);
                          }
                        }}
                      >
                        <div className="flex items-center gap-2">
                          {batchMode ? (
                            <span className="flex-shrink-0">
                              {isSelected ? <CheckSquare size={16} className="text-primary" /> : <Square size={16} className="text-muted-foreground" />}
                            </span>
                          ) : (
                            <CaretRight className={cn(
                              'w-3.5 h-3.5 text-muted-foreground transition-transform duration-200',
                              isExpanded && 'rotate-90'
                            )} />
                          )}
                          <FileText size={14} className="text-muted-foreground" />
                          <span className="text-sm font-medium truncate">{result.noteTitle}</span>
                          <span className="text-2xs text-muted-foreground/60 ml-auto tabular-nums">
                            {(result.score * 100).toFixed(0)}%
                          </span>
                        </div>
                        {!isExpanded && (
                          <p className="text-xs text-muted-foreground line-clamp-1 pl-7">
                            {result.chunkText}
                          </p>
                        )}
                      </div>
                      {/* 内联展开预览 + 编辑 */}
                      <AnimatePresence initial={false}>
                        {isExpanded && (
                          <motion.div key="expand" {...disclosureMotion} className="overflow-hidden">
                            <MemoryExpandPanel
                              noteId={result.noteId}
                              noteTitle={result.noteTitle}
                              isLoadingContent={isLoadingContent}
                              expandedContent={expandedContent}
                              editingMemoryId={editingMemoryId}
                              editContent={editContent}
                              onEditContentChange={setEditContent}
                              onStartEdit={handleStartEdit}
                              onSaveEdit={handleSaveEdit}
                              onCancelEdit={handleCancelEdit}
                              onDeleteNote={handleDeleteMemory}
                              confirmingDelete={confirmingDeleteId === result.noteId}
                              onOpenInEditor={handleOpenInEditor}
                              isLoading={isMutating}
                              className="mx-3 mb-2"
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            )
          ) : viewMode === 'list' && memories.length === 0 ? (
            // 空状态 - 更简洁
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <MemoryIcon size={40} className="mb-3 opacity-40" />
              <span className="text-sm mb-2">{t('memory.empty')}</span>
              <NotionButton variant="ghost" size="sm" onClick={handleOpenCreate} className="text-primary hover:underline !p-0 !h-auto">
                {t('memory.create_first')}
              </NotionButton>
            </div>
          ) : viewMode === 'list' ? (
            // 记忆列表 - 内联展开布局 + 批量选择 + 内联编辑
            <div className="space-y-0.5">
              {displayMemories.map((memory) => {
                const isExpanded = expandedMemoryId === memory.id;
                const isSelected = selectedIds.has(memory.id);
                const isConfirmingDelete = confirmingDeleteId === memory.id;
                return (
                  <div key={memory.id} className="rounded-lg" data-memory-row={memory.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      className={cn(
                        'group flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
                        isExpanded ? 'bg-muted/50' : !isSelected && 'hover:bg-[var(--interactive-hover)]',
                        isSelected && 'bg-primary/5'
                      )}
                      onClick={() => batchMode ? toggleSelect(memory.id) : handleToggleExpand(memory.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          if (batchMode) toggleSelect(memory.id); else handleToggleExpand(memory.id);
                        }
                      }}
                    >
                      {batchMode ? (
                        <span className="flex-shrink-0">
                          {isSelected ? <CheckSquare size={16} className="text-primary" /> : <Square size={16} className="text-muted-foreground" />}
                        </span>
                      ) : (
                        <CaretRight className={cn(
                          'w-3.5 h-3.5 text-muted-foreground flex-shrink-0 transition-transform duration-200',
                          isExpanded && 'rotate-90'
                        )} />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium truncate">{memory.title}</span>
                          {memory.memoryType === 'fact' && (
                            <span className="flex items-center gap-0.5 px-1.5 py-0 rounded bg-amber-500/10 text-amber-600 text-2xs font-medium flex-shrink-0">
                              <Sparkle size={10} />
                              {t('memory.type_fact')}
                            </span>
                          )}
                          {memory.memoryType === 'note' && (
                            <span className="flex items-center gap-0.5 px-1.5 py-0 rounded bg-blue-500/10 text-blue-600 text-2xs font-medium flex-shrink-0">
                              <BookOpen size={10} />
                              {t('memory.type_note')}
                            </span>
                          )}
                          {memory.memoryType === 'study' && (
                            <span className="flex items-center gap-0.5 px-1.5 py-0 rounded bg-emerald-500/10 text-emerald-600 text-2xs font-medium flex-shrink-0">
                              <FileText size={10} />
                              {t('memory.type_study')}
                            </span>
                          )}
                          {memory.memoryPurpose && memory.memoryPurpose !== 'memorized' && (
                            <span className={cn(
                              'px-1.5 py-0 rounded text-2xs font-medium flex-shrink-0',
                              PURPOSE_BADGE_STYLES[memory.memoryPurpose] || 'bg-muted text-muted-foreground'
                            )}>
                              {purposeLabel(t, memory.memoryPurpose)}
                            </span>
                          )}
                          {memory.isImportant && (
                            <Star size={12} className="text-amber-500 flex-shrink-0" weight="fill" />
                          )}
                          {memory.isStale && !memory.isArchived && (
                            <NotionButton
                              variant="ghost" size="sm"
                              className="!h-auto !px-1.5 !py-0 text-2xs text-muted-foreground hover:text-primary hover:bg-primary/10 flex-shrink-0"
                              title={t('memory.stale_tooltip')}
                              onClick={(event) => { event.stopPropagation(); handleRestoreStale(memory.id); }}
                              aria-label={t('memory.restore_stale')}
                            >
                              <Clock size={10} />
                              {t('memory.restore_stale')}
                            </NotionButton>
                          )}
                          {memory.isArchived && (
                            <NotionButton
                              variant="ghost" size="sm"
                              className="!h-auto !px-1.5 !py-0 text-2xs text-muted-foreground hover:text-primary hover:bg-primary/10 flex-shrink-0"
                              title={t('memory.archived_tooltip')}
                              onClick={(event) => { event.stopPropagation(); handleRestoreArchived(memory.id); }}
                              aria-label={t('memory.restore_archived')}
                            >
                              <Archive size={10} />
                              {t('memory.archived_badge')}
                            </NotionButton>
                          )}
                          {memory.needsDedupReview && (
                            <span
                              className="px-1.5 py-0 rounded bg-warning/10 text-warning text-2xs font-medium flex-shrink-0"
                              title={t('memory.needs_dedup_review_tooltip')}
                            >
                              {t('memory.needs_dedup_review')}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{new Date(memory.updatedAt).toLocaleDateString()}</span>
                          {memory.folderPath && (
                            <span className="px-1.5 py-0 rounded bg-muted/50 text-2xs">{memory.folderPath}</span>
                          )}
                          {memory.hits > 0 && (
                            <span className="text-2xs text-muted-foreground/50">{memory.hits} {t('memory.hits')}</span>
                          )}
                        </div>
                      </div>
                      {!batchMode && (
                        isConfirmingDelete ? (
                          <NotionButton
                            variant="ghost" size="sm"
                            className="!h-auto !px-2 !py-1 text-[11px] text-danger bg-danger/10 hover:bg-danger/20 font-medium flex-shrink-0"
                            onClick={(event) => { event.stopPropagation(); handleDeleteMemory(memory.id); }}
                            aria-label={t('memory.aria.delete')}
                          >
                            <Trash size={12} />
                            {t('memory.confirm_delete')}
                          </NotionButton>
                        ) : (
                          // 触屏无 hover：删除钮常显弱化态（[@media(pointer:coarse)]），避免隐形可点
                          <NotionButton variant="ghost" size="icon" iconOnly className="!p-1.5 text-muted-foreground/0 group-hover:text-muted-foreground group-focus-within:text-muted-foreground [@media(pointer:coarse)]:text-muted-foreground hover:text-danger hover:bg-danger/10" onClick={(event) => { event.stopPropagation(); handleDeleteMemory(memory.id); }} aria-label={t('memory.aria.delete')}>
                            <Trash size={14} />
                          </NotionButton>
                        )
                      )}
                    </div>
                    <AnimatePresence initial={false}>
                      {isExpanded && !batchMode && (
                        <motion.div key="expand" {...disclosureMotion} className="overflow-hidden">
                          <MemoryExpandPanel
                            noteId={memory.id}
                            noteTitle={memory.title}
                            isLoadingContent={isLoadingContent}
                            expandedContent={expandedContent}
                            editingMemoryId={editingMemoryId}
                            editContent={editContent}
                            onEditContentChange={setEditContent}
                            onStartEdit={handleStartEdit}
                            onSaveEdit={handleSaveEdit}
                            onCancelEdit={handleCancelEdit}
                            onDeleteNote={handleDeleteMemory}
                            confirmingDelete={confirmingDeleteId === memory.id}
                            onOpenInEditor={handleOpenInEditor}
                            isLoading={isMutating}
                            className="mx-3 mb-2"
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
              {hasMoreMemories && (
                <div className="flex justify-center py-2">
                  <NotionButton variant="ghost" size="sm" onClick={handleLoadMoreMemories} disabled={isLoadingMore} className="text-xs text-muted-foreground">
                    {isLoadingMore ? <CircleNotch size={12} className="animate-spin" /> : null}
                    {t('memory.load_more')}
                  </NotionButton>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </CustomScrollArea>
    </div>
  );
};

// ============================================================================
// 树状视图节点组件
// ============================================================================

interface NoteMetaInfo {
  title: string;
  memoryType?: string;
  memoryPurpose?: string;
  isImportant?: boolean;
  isStale?: boolean;
}

interface MemoryTreeNodeProps {
  node: FolderTreeNode;
  expandedFolders: Set<string>;
  noteTitleMap: Record<string, NoteMetaInfo>;
  onToggleFolder: (folderId: string) => void;
  onClickNote: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  confirmingDeleteId: string | null;
  onOpenInEditor: (noteId: string, title: string) => void;
  expandedMemoryId: string | null;
  expandedContent: MemoryReadOutput | null;
  isLoadingContent: boolean;
  editingMemoryId: string | null;
  editContent: string;
  onEditContentChange: (content: string) => void;
  onStartEdit: (noteId: string, content: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  isLoading: boolean;
  depth: number;
  isRoot?: boolean;
}

const MemoryTreeNode: React.FC<MemoryTreeNodeProps> = React.memo(({
  node, expandedFolders, noteTitleMap, onToggleFolder, onClickNote, onDeleteNote, confirmingDeleteId, onOpenInEditor,
  expandedMemoryId, expandedContent, isLoadingContent,
  editingMemoryId, editContent, onEditContentChange, onStartEdit, onSaveEdit, onCancelEdit,
  isLoading, depth, isRoot,
}) => {
  const { t } = useTranslation('learningHub');
  const disclosureMotion = useDisclosureMotion();
  const isFolderExpanded = isRoot || expandedFolders.has(node.folder.id);
  const hasChildren = node.children.length > 0 || node.items.length > 0;
  const paddingLeft = depth * 16;

  return (
    <div>
      {!isRoot && (
        <div
          role="button"
          tabIndex={0}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded-md transition-colors',
            'hover:bg-[var(--interactive-hover)]',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
            isFolderExpanded && 'bg-muted/20'
          )}
          style={{ paddingLeft: `${paddingLeft + 12}px` }}
          onClick={() => onToggleFolder(node.folder.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleFolder(node.folder.id);
            }
          }}
        >
          <CaretRight className={cn(
            'w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 flex-shrink-0',
            isFolderExpanded && 'rotate-90'
          )} />
          <Folder size={14} className="text-amber-500 flex-shrink-0" />
          <span className="text-sm font-medium truncate">{node.folder.title}</span>
          {hasChildren && (
            <span className="text-2xs text-muted-foreground/50 ml-auto">
              {node.items.length}
            </span>
          )}
        </div>
      )}

      {isFolderExpanded && (
        <div>
          {node.children.map((child) => (
            <MemoryTreeNode
              key={child.folder.id}
              node={child}
              expandedFolders={expandedFolders}
              noteTitleMap={noteTitleMap}
              onToggleFolder={onToggleFolder}
              onClickNote={onClickNote}
              onDeleteNote={onDeleteNote}
              confirmingDeleteId={confirmingDeleteId}
              onOpenInEditor={onOpenInEditor}
              expandedMemoryId={expandedMemoryId}
              expandedContent={expandedContent}
              isLoadingContent={isLoadingContent}
              editingMemoryId={editingMemoryId}
              editContent={editContent}
              onEditContentChange={onEditContentChange}
              onStartEdit={onStartEdit}
              onSaveEdit={onSaveEdit}
              onCancelEdit={onCancelEdit}
              isLoading={isLoading}
              depth={isRoot ? depth : depth + 1}
            />
          ))}

          {node.items
            .filter((item) => item.itemType === 'note')
            .map((item) => {
              const noteId = item.itemId;
              const isNoteExpanded = expandedMemoryId === noteId;
              const childPadding = (isRoot ? depth : depth + 1) * 16;
              const meta = noteTitleMap[noteId];
              const noteTitle = meta?.title || noteId;
              const isConfirmingDelete = confirmingDeleteId === noteId;

              return (
                <div key={item.id} data-memory-row={noteId}>
                  <div
                    role="button"
                    tabIndex={0}
                    className={cn(
                      'group flex items-center gap-2 px-3 py-2 cursor-pointer rounded-md transition-colors',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
                      isNoteExpanded ? 'bg-muted/50' : 'hover:bg-[var(--interactive-hover)]'
                    )}
                    style={{ paddingLeft: `${childPadding + 28}px` }}
                    onClick={() => onClickNote(noteId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onClickNote(noteId);
                      }
                    }}
                  >
                    <CaretRight className={cn(
                      'w-3 h-3 text-muted-foreground flex-shrink-0 transition-transform duration-200',
                      isNoteExpanded && 'rotate-90'
                    )} />
                    <FileText size={14} className="text-muted-foreground flex-shrink-0" />
                    <span className="text-sm truncate flex-1">{noteTitle}</span>
                    {meta?.memoryPurpose && meta.memoryPurpose !== 'memorized' && (
                      <span className={cn(
                        'px-1.5 py-0 rounded text-2xs font-medium flex-shrink-0',
                        PURPOSE_BADGE_STYLES[meta.memoryPurpose] || 'bg-muted text-muted-foreground'
                      )}>
                        {purposeLabel(t, meta.memoryPurpose)}
                      </span>
                    )}
                    {meta?.isImportant && (
                      <Star size={12} className="text-amber-500 flex-shrink-0" weight="fill" />
                    )}
                    {isConfirmingDelete ? (
                      <NotionButton
                        variant="ghost" size="sm"
                        className="!h-auto !px-1.5 !py-0.5 text-2xs text-danger bg-danger/10 hover:bg-danger/20 font-medium flex-shrink-0"
                        onClick={(e) => { e.stopPropagation(); onDeleteNote(noteId); }}
                        aria-label={t('memory.aria.delete')}
                      >
                        <Trash size={10} />
                        {t('memory.confirm_delete')}
                      </NotionButton>
                    ) : (
                      <NotionButton
                        variant="ghost" size="icon" iconOnly
                        // 触屏无 hover：删除钮常显弱化态，避免隐形可点
                        className="!p-1 text-muted-foreground/0 group-hover:text-muted-foreground group-focus-within:text-muted-foreground [@media(pointer:coarse)]:text-muted-foreground hover:text-danger hover:bg-danger/10"
                        onClick={(e) => { e.stopPropagation(); onDeleteNote(noteId); }}
                        aria-label={t('memory.aria.delete')}
                      >
                        <Trash size={12} />
                      </NotionButton>
                    )}
                  </div>

                  <AnimatePresence initial={false}>
                    {isNoteExpanded && (
                      <motion.div key="expand" {...disclosureMotion} className="overflow-hidden">
                        <MemoryExpandPanel
                          noteId={noteId}
                          noteTitle={noteTitle}
                          isLoadingContent={isLoadingContent}
                          expandedContent={expandedContent}
                          editingMemoryId={editingMemoryId}
                          editContent={editContent}
                          onEditContentChange={onEditContentChange}
                          onStartEdit={onStartEdit}
                          onSaveEdit={onSaveEdit}
                          onCancelEdit={onCancelEdit}
                          onDeleteNote={onDeleteNote}
                          confirmingDelete={confirmingDeleteId === noteId}
                          onOpenInEditor={onOpenInEditor}
                          isLoading={isLoading}
                          className="mx-3 mb-1"
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
});

MemoryTreeNode.displayName = 'MemoryTreeNode';

// ============================================================================
// 内联展开面板（搜索结果/列表/树状共用）
// ============================================================================

interface MemoryExpandPanelProps {
  noteId: string;
  noteTitle: string;
  isLoadingContent: boolean;
  expandedContent: MemoryReadOutput | null;
  editingMemoryId: string | null;
  editContent: string;
  onEditContentChange: (value: string) => void;
  onStartEdit: (noteId: string, content: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDeleteNote: (noteId: string) => void;
  confirmingDelete: boolean;
  onOpenInEditor: (noteId: string, title: string) => void;
  isLoading: boolean;
  className?: string;
}

const MemoryExpandPanel: React.FC<MemoryExpandPanelProps> = React.memo(({
  noteId, noteTitle, isLoadingContent, expandedContent,
  editingMemoryId, editContent, onEditContentChange,
  onStartEdit, onSaveEdit, onCancelEdit,
  onDeleteNote, confirmingDelete, onOpenInEditor, isLoading, className,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const isEditing = editingMemoryId === noteId;
  // ★ 长文本"展开全文"切换（默认 line-clamp-6）
  const [showFullContent, setShowFullContent] = React.useState(false);
  React.useEffect(() => {
    setShowFullContent(false);
  }, [noteId]);
  const content = expandedContent?.content || '';
  const isLongContent = content.length > 360 || content.split('\n').length > 6;

  return (
    <div className={cn('rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-card/60 overflow-hidden shadow-sm', className)}>
      {isLoadingContent ? (
        <div className="flex items-center justify-center py-6">
          <CircleNotch size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : expandedContent ? (
        <>
          {isEditing ? (
            <div className="p-3 space-y-2">
              <textarea
                ref={(el) => {
                  if (el) {
                    el.style.height = 'auto';
                    el.style.height = el.scrollHeight + 'px';
                  }
                }}
                value={editContent}
                onChange={(e) => {
                  onEditContentChange(e.target.value);
                  const el = e.target;
                  el.style.height = 'auto';
                  el.style.height = el.scrollHeight + 'px';
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    onCancelEdit();
                  } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isLoading) {
                    e.preventDefault();
                    onSaveEdit();
                  }
                }}
                autoFocus
                className="w-full px-3 py-2 text-xs bg-muted/30 border-transparent rounded-md resize-none overflow-hidden focus:border-border focus:bg-background focus:outline-none transition-colors"
              />
              <div className="flex gap-2">
                <NotionButton variant="ghost" size="sm" onClick={onCancelEdit} className="!h-auto !px-2 !py-1 text-xs">
                  <X size={12} />{t('common:cancel')}
                </NotionButton>
                <NotionButton variant="primary" size="sm" onClick={onSaveEdit} disabled={isLoading} className="!h-auto !px-2 !py-1 text-xs">
                  {isLoading ? <CircleNotch size={12} className="animate-spin" /> : <FloppyDisk size={12} />}
                  {t('common:save')}
                </NotionButton>
              </div>
            </div>
          ) : (
            <div className="px-3 py-2">
              <div className={cn(
                'text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed',
                !showFullContent && 'line-clamp-6'
              )}>
                {content || t('memory.no_content')}
              </div>
              {isLongContent && (
                <button
                  className="mt-1 text-[11px] text-primary hover:underline"
                  onClick={(e) => { e.stopPropagation(); setShowFullContent(v => !v); }}
                >
                  {showFullContent ? t('memory.show_less') : t('memory.show_full')}
                </button>
              )}
            </div>
          )}
          <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/30 bg-muted/20">
            <div className="flex items-center gap-1.5">
              <NotionButton
                variant="ghost" size="sm"
                onClick={(e) => { e.stopPropagation(); onDeleteNote(noteId); }}
                className={cn(
                  'text-danger hover:bg-danger/10 !h-auto !px-2 !py-1 text-xs transition-colors',
                  confirmingDelete && 'bg-danger/15 font-medium'
                )}
              >
                <Trash size={12} />
                {confirmingDelete ? t('memory.confirm_delete') : t('common:delete')}
              </NotionButton>
              {!isEditing && (
                <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onStartEdit(noteId, content); }} className="text-muted-foreground hover:bg-[var(--interactive-hover)] !h-auto !px-2 !py-1 text-xs">
                  <PencilSimple size={12} />{t('memory.edit')}
                </NotionButton>
              )}
            </div>
            <NotionButton variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onOpenInEditor(noteId, noteTitle); }} className="text-primary bg-primary/10 hover:bg-primary/15 !h-auto !px-2 !py-1 text-xs font-medium">
              <ArrowSquareOut size={12} />{t('memory.open_editor')}
            </NotionButton>
          </div>
        </>
      ) : null}
    </div>
  );
});

MemoryExpandPanel.displayName = 'MemoryExpandPanel';

// ============================================================================
// 审计日志行组件
// ============================================================================

const PURPOSE_I18N_KEYS: Record<string, string> = {
  internalized: 'finder.memoryMeta.purpose.internalized',
  memorized: 'finder.memoryMeta.purpose.memorized',
  supplementary: 'finder.memoryMeta.purpose.supplementary',
  systemic: 'finder.memoryMeta.purpose.systemic',
};

function purposeLabel(t: (key: string) => string, purpose: string): string {
  const key = PURPOSE_I18N_KEYS[purpose];
  return key ? t(key) : purpose;
}

const PURPOSE_BADGE_STYLES: Record<string, string> = {
  internalized: 'bg-violet-500/10 text-violet-600',
  supplementary: 'bg-teal-500/10 text-teal-600',
  systemic: 'bg-slate-500/10 text-slate-500',
};

const SOURCE_META: Record<string, { labelKey: string; icon: React.ReactNode; color: string }> = {
  tool_call: { labelKey: 'memory.audit_source_tool', icon: <Robot size={12} />, color: 'text-blue-500' },
  auto_extract: { labelKey: 'memory.audit_source_auto', icon: <Lightning className="w-3 h-3" />, color: 'text-amber-500' },
  handler: { labelKey: 'memory.audit_source_handler', icon: <User size={12} />, color: 'text-emerald-500' },
  evolution: { labelKey: 'memory.audit_source_evolution', icon: <ArrowClockwise className="w-3 h-3" />, color: 'text-purple-500' },
  semantic_dedup: { labelKey: 'memory.audit_source_semantic_dedup', icon: <ArrowClockwise className="w-3 h-3" />, color: 'text-teal-500' },
};

const OPERATION_I18N_KEYS: Record<string, string> = {
  write: 'memory.operation.write',
  write_smart: 'memory.operation.write_smart',
  update: 'memory.operation.update',
  delete: 'memory.operation.delete',
  search: 'memory.operation.search',
  extract: 'memory.operation.extract',
  profile_refresh: 'memory.operation.profile_refresh',
  category_refresh: 'memory.operation.category_refresh',
  evolution_cycle: 'memory.operation.evolution_cycle',
  move: 'memory.operation.move',
  update_tags: 'memory.operation.update_tags',
  add_relation: 'memory.operation.add_relation',
  remove_relation: 'memory.operation.remove_relation',
  decision_breaker: 'memory.operation.decision_breaker',
  semantic_merge: 'memory.operation.semantic_merge',
};

const EVENT_COLORS: Record<string, string> = {
  ADD: 'bg-success/15 text-success',
  UPDATE: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  APPEND: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  DELETE: 'bg-danger/15 text-danger',
  NONE: 'bg-muted text-muted-foreground',
  FILTERED: 'bg-warning/15 text-warning',
  SKIPPED: 'bg-muted text-muted-foreground',
  STALE_DEMOTE: 'bg-warning/15 text-warning',
  STALE_RESTORE: 'bg-success/15 text-success',
  ARCHIVE: 'bg-warning/15 text-warning',
  ARCHIVE_RESTORE: 'bg-success/15 text-success',
  SEMANTIC_MERGE: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
};

const AuditLogRow: React.FC<{ log: MemoryAuditLogItem }> = React.memo(({ log }) => {
  const { t, i18n } = useTranslation('learningHub');
  const [expanded, setExpanded] = React.useState(false);
  const disclosureMotion = useDisclosureMotion();
  const sourceMeta = SOURCE_META[log.source] ?? { labelKey: '', icon: null, color: 'text-muted-foreground' };
  const sourceLabel = sourceMeta.labelKey ? t(sourceMeta.labelKey) : log.source;
  const operationLabel = OPERATION_I18N_KEYS[log.operation]
    ? t(OPERATION_I18N_KEYS[log.operation])
    : log.operation;
  const ts = new Date(log.timestamp);
  const timeStr = `${ts.toLocaleDateString(i18n.language)} ${ts.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

  return (
    <div className="group">
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-[var(--interactive-hover)] transition-colors',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50'
        )}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(v => !v);
          }
        }}
      >
        <CaretRight className={cn(
          'w-3 h-3 text-muted-foreground/50 transition-transform duration-150 flex-shrink-0',
          expanded && 'rotate-90'
        )} />

        {/* 成功/失败图标 */}
        {log.success ? (
          <CheckCircle size={14} className="text-success flex-shrink-0" />
        ) : (
          <XCircle size={14} className="text-danger flex-shrink-0" />
        )}

        {/* 来源 */}
        <span className={cn('flex items-center gap-1 text-2xs font-medium flex-shrink-0', sourceMeta.color)}>
          {sourceMeta.icon}
          {sourceLabel}
        </span>

        {/* 操作 */}
        <span className="text-2xs text-muted-foreground flex-shrink-0">{operationLabel}</span>

        {/* 事件标签 */}
        {log.event && (
          <span className={cn(
            'px-1.5 py-0 rounded text-2xs font-medium flex-shrink-0',
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
        <span className="text-2xs text-muted-foreground/60 flex-shrink-0 tabular-nums">
          {timeStr}
        </span>

        {/* 耗时 */}
        {log.durationMs != null && (
          <span className="text-2xs text-muted-foreground/40 flex-shrink-0 tabular-nums w-12 text-right">
            {log.durationMs}ms
          </span>
        )}
      </div>

      {/* 展开详情 */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div key="detail" {...disclosureMotion} className="overflow-hidden">
            <div className="px-4 pb-3 ml-7 space-y-1.5">
              {log.noteId && (
                <div className="text-2xs">
                  <span className="text-muted-foreground/60">{t('memory.audit_field.note_id')}: </span>
                  <code className="text-2xs bg-muted/50 px-1 rounded">{log.noteId}</code>
                </div>
              )}
              {log.contentPreview && (
                <div className="text-2xs">
                  <span className="text-muted-foreground/60">{t('memory.audit_field.content')}: </span>
                  <span className="text-muted-foreground">{log.contentPreview}</span>
                </div>
              )}
              {log.folder && (
                <div className="text-2xs">
                  <span className="text-muted-foreground/60">{t('memory.audit_field.folder')}: </span>
                  <span className="text-muted-foreground">{log.folder}</span>
                </div>
              )}
              {log.confidence != null && (
                <div className="text-2xs">
                  <span className="text-muted-foreground/60">{t('memory.audit_field.confidence')}: </span>
                  <span className={cn(
                    'font-medium',
                    log.confidence >= 0.8 ? 'text-success' :
                    log.confidence >= 0.5 ? 'text-warning' : 'text-danger'
                  )}>
                    {(log.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              )}
              {log.reason && (
                <div className="text-2xs">
                  <span className="text-muted-foreground/60">{t('memory.audit_field.reason')}: </span>
                  <span className="text-muted-foreground">{log.reason}</span>
                </div>
              )}
              {log.sessionId && (
                <div className="text-2xs">
                  <span className="text-muted-foreground/60">{t('memory.audit_field.session')}: </span>
                  <code className="text-2xs bg-muted/50 px-1 rounded">{log.sessionId}</code>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

AuditLogRow.displayName = 'AuditLogRow';

export default MemoryView;
