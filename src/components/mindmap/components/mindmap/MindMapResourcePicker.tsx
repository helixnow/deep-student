/**
 * 思维导图资源选择器弹窗
 *
 * 允许用户从 VFS 中搜索/浏览资源并关联到思维导图节点。
 * 轻量级实现，使用 dstu_list / dstu_search API。
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import {
  Search,
  X,
  FileText,
  BookOpen,
  ClipboardList,
  Languages,
  Pencil,
  Brain,
  Image as ImageIcon,
  File,
  Loader2,
  Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Z_INDEX } from '@/config/zIndex';
import * as dstuApi from '@/dstu/api';
import type { DstuNode } from '@/dstu/types';
import type { MindMapNodeRef } from '../../types';

// ============================================================================
// 类型
// ============================================================================

export interface MindMapResourcePickerProps {
  isOpen: boolean;
  nodeId: string;
  existingRefs?: MindMapNodeRef[];
  onSelect: (ref: MindMapNodeRef) => void;
  onClose: () => void;
}

// ============================================================================
// 图标映射
// ============================================================================

const getTypeIcon = (type: string): React.ElementType => {
  switch (type) {
    case 'note': return FileText;
    case 'textbook': return BookOpen;
    case 'exam': return ClipboardList;
    case 'essay': return Pencil;
    case 'translation': return Languages;
    case 'mindmap': return Brain;
    case 'image': return ImageIcon;
    case 'file': return File;
    default: return FileText;
  }
};

const getTypeBadgeClass = (type: string): string => {
  switch (type) {
    case 'note': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'textbook': return 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300';
    case 'exam': return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300';
    case 'essay': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
    case 'translation': return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
    case 'mindmap': return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300';
    default: return 'bg-muted text-muted-foreground';
  }
};

// ============================================================================
// 组件
// ============================================================================

export const MindMapResourcePicker: React.FC<MindMapResourcePickerProps> = ({
  isOpen,
  nodeId,
  existingRefs,
  onSelect,
  onClose,
}) => {
  const { t } = useTranslation('mindmap');
  const [query, setQuery] = useState('');
  const [resources, setResources] = useState<DstuNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const existingIds = useMemo(() => new Set(existingRefs?.map(r => r.sourceId) ?? []), [existingRefs]);

  // 加载根目录资源
  const loadRootResources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await dstuApi.list('/', { recursive: true });
      if (result.ok) {
        // 过滤掉文件夹，只保留资源
        setResources(result.value.filter(n => n.type !== 'folder'));
      } else {
        setError(result.error.message);
      }
    } catch {
      setError('Failed to load resources');
    } finally {
      setLoading(false);
    }
  }, []);

  // 搜索资源
  const searchResources = useCallback(async (q: string) => {
    if (!q.trim()) {
      loadRootResources();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await dstuApi.search(q.trim());
      if (result.ok) {
        setResources(result.value.filter(n => n.type !== 'folder'));
      } else {
        setError(result.error.message);
      }
    } catch {
      setError('Search failed');
    } finally {
      setLoading(false);
    }
  }, [loadRootResources]);

  // 打开时加载资源 + 聚焦搜索框
  useEffect(() => {
    if (isOpen) {
      loadRootResources();
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setResources([]);
    }
  }, [isOpen, loadRootResources]);

  // 搜索防抖（仅在用户实际输入时触发，避免与初始加载重复）
  useEffect(() => {
    if (!isOpen || !query) return;
    const timer = setTimeout(() => {
      searchResources(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, isOpen, searchResources]);

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 延迟绑定，避免触发菜单关闭的同一事件立即关闭 picker
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', handleClick);
      window.addEventListener('keydown', handleEscape);
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- onClose 引用稳定性由 useCallback 在父组件保证

  const handleSelect = useCallback((node: DstuNode) => {
    const ref: MindMapNodeRef = {
      sourceId: node.sourceId || node.id,
      type: node.type,
      name: node.name,
      resourceHash: node.resourceHash,
    };
    onSelect(ref);
  }, [onSelect]);

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={panelRef}
      className={cn(
        'fixed w-[360px] max-h-[420px] flex flex-col',
        'rounded-lg border border-border bg-popover shadow-xl',
        'animate-in fade-in-0 zoom-in-95 duration-150',
        'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
      )}
      style={{ zIndex: Z_INDEX.contextMenu + 10 }}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">{t('refs.pickerTitle', '关联资源')}</span>
        <NotionButton variant="ghost" onClick={onClose} className="w-6 h-6 p-0">
          <X className="w-4 h-4" />
        </NotionButton>
      </div>

      {/* 搜索框 */}
      <div className="px-3 py-2 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('refs.searchPlaceholder', '搜索资源...')}
            className={cn(
              'w-full pl-7 pr-2 py-1.5 text-sm rounded-md',
              'bg-muted/50 border border-border/50',
              'focus:outline-none focus:ring-1 focus:ring-primary/50',
              'placeholder:text-muted-foreground/60',
            )}
          />
        </div>
      </div>

      {/* 资源列表 */}
      <div className="flex-1 overflow-y-auto min-h-0 p-1">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            <span className="text-sm">{t('refs.loading', '加载中...')}</span>
          </div>
        ) : error ? (
          <div className="text-center py-8 text-sm text-destructive">{error}</div>
        ) : resources.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            {query ? t('refs.noResults', '未找到匹配资源') : t('refs.empty', '暂无资源')}
          </div>
        ) : (
          resources.map((node) => {
            const Icon = getTypeIcon(node.type);
            const isAdded = existingIds.has(node.sourceId || node.id);
            const badgeClass = getTypeBadgeClass(node.type);

            return (
              <NotionButton
                key={node.id}
                variant="ghost" size="sm"
                disabled={isAdded}
                onClick={() => handleSelect(node)}
                className={cn(
                  '!w-full !justify-start !px-2 !py-1.5 !h-auto !rounded-md !text-left',
                  isAdded
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:bg-accent cursor-pointer',
                )}
              >
                <span className={cn('w-5 h-5 rounded flex items-center justify-center shrink-0', badgeClass)}>
                  <Icon className="w-3 h-3" />
                </span>
                <span className="flex-1 min-w-0 text-sm truncate">{node.name}</span>
                {isAdded && (
                  <Check className="w-3.5 h-3.5 text-primary shrink-0" />
                )}
              </NotionButton>
            );
          })
        )}
      </div>
    </div>,
    window.document.body
  );
};
