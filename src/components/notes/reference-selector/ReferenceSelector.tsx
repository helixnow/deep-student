/**
 * 引用选择器弹窗
 *
 * 用于选择要引用的教材/题目集识别资源
 *
 * 功能特性：
 * 1. 支持搜索过滤
 * 2. 显示资源预览（教材显示封面缩略图）
 * 3. 单选模式
 * 4. 选择后返回 ReferenceNode 所需信息
 * 5. 已被引用的资源显示禁用状态
 * 6. 使用 i18n 国际化
 * 7. 支持亮色/暗色模式
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { Search, X, BookOpen, FileSpreadsheet, Loader2, AlertCircle } from 'lucide-react';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody } from '../../ui/NotionDialog';
import { CustomScrollArea } from '../../custom-scroll-area';
import { cn } from '../../../lib/utils';
import { getErrorMessage } from '../../../utils/errorUtils';
import { listTextbooks, listExamSessions } from './api';
import { ReferenceSelectorItem } from './ReferenceSelectorItem';
import type {
  ReferenceSelectorProps,
  UnifiedResourceItem,
  ReferenceSelectResult,
  TextbookListItem,
  ExamSessionListItem,
} from './types';

/**
 * 将教材列表项转换为统一资源项
 */
function textbookToUnified(item: TextbookListItem): UnifiedResourceItem {
  return {
    id: item.id,
    title: item.title,
    updatedAt: item.updatedAt,
    thumbnail: item.coverPath,
    sourceDb: 'textbooks',
    previewType: 'pdf',
  };
}

/**
 * 将题目集会话列表项转换为统一资源项
 * @param item 题目集会话列表项
 * @param fallbackTitle 无 examName 时的回退标题前缀（已国际化）
 */
function examSessionToUnified(
  item: ExamSessionListItem,
  fallbackTitle: string
): UnifiedResourceItem {
  // 标题优先使用 examName，否则使用国际化的回退标题 + ID 前 8 位
  const title = item.examName || `${fallbackTitle} ${item.id.substring(0, 8)}`;
  return {
    id: item.id,
    title,
    updatedAt: item.createdAt, // 题目集使用 createdAt
    thumbnail: undefined,
    sourceDb: 'exam_sessions',
    previewType: 'exam',
  };
}

export const ReferenceSelector: React.FC<ReferenceSelectorProps> = ({
  open,
  onOpenChange,
  type,
  onSelect,
  existingRefs = [],
}) => {
  const { t } = useTranslation(['notes', 'common']);

  // 状态
  const [searchQuery, setSearchQuery] = useState('');
  const [items, setItems] = useState<UnifiedResourceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 已引用的资源 ID 集合（用于快速查找）
  const existingRefIds = useMemo(() => {
    let sourceDb: string;
    switch (type) {
      case 'textbook':
        sourceDb = 'textbooks';
        break;
      case 'exam_session':
        sourceDb = 'exam_sessions';
        break;
      default:
        sourceDb = 'textbooks';
    }
    return new Set(
      existingRefs
        .filter(ref => ref.sourceDb === sourceDb)
        .map(ref => ref.sourceId)
    );
  }, [existingRefs, type]);

  // 加载数据
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      if (type === 'textbook') {
        const result = await listTextbooks(searchQuery || undefined);
        if (!result.ok) {
          setError(result.error.toUserMessage());
          setItems([]);
          return;
        }
        setItems(result.value.map(textbookToUnified));
      } else if (type === 'exam_session') {
        const result = await listExamSessions();
        if (!result.ok) {
          setError(result.error.toUserMessage());
          setItems([]);
          return;
        }
        const fallbackTitle = t('notes:reference.examSessionFallbackTitle');
        setItems(result.value.map(s => examSessionToUnified(s, fallbackTitle)));
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [type, searchQuery, t]);

  // 打开时加载数据
  useEffect(() => {
    if (open) {
      setSelectedId(null);
      setSearchQuery('');
      loadData();
    }
  }, [open, type]); // 不依赖 loadData 避免循环

  // 搜索防抖
  useEffect(() => {
    if (!open) return;

    const timer = setTimeout(() => {
      loadData();
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery, open, loadData]);

  // 处理选择
  const handleSelect = useCallback((item: UnifiedResourceItem) => {
    if (existingRefIds.has(item.id)) return;
    setSelectedId(item.id);
  }, [existingRefIds]);

  // 确认选择
  const handleConfirm = useCallback(() => {
    if (!selectedId) return;

    const selectedItem = items.find(item => item.id === selectedId);
    if (!selectedItem) return;

    const result: ReferenceSelectResult = {
      sourceDb: selectedItem.sourceDb,
      sourceId: selectedItem.id,
      title: selectedItem.title,
      previewType: selectedItem.previewType,
    };

    onSelect(result);
    onOpenChange(false);
  }, [selectedId, items, onSelect, onOpenChange]);

  // 获取标题
  const dialogTitle = useMemo(() => {
    switch (type) {
      case 'textbook':
        return t('notes:reference.selectTextbook');
      case 'exam_session':
        return t('notes:reference.selectExamSession');
      default:
        return t('notes:reference.selectTextbook');
    }
  }, [type, t]);

  // 获取空状态文案
  const emptyText = useMemo(() => {
    switch (type) {
      case 'textbook':
        return t('notes:reference.noTextbooks');
      case 'exam_session':
        return t('notes:reference.noExamSessions');
      default:
        return t('notes:reference.noTextbooks');
    }
  }, [type, t]);

  return (
    <NotionDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-lg" showClose={false}>
        {/* 头部 */}
        <NotionDialogHeader>
          <div className="flex items-center justify-between">
            <NotionDialogTitle className="flex items-center gap-2">
              {type === 'textbook' && (
                <BookOpen className="h-5 w-5 text-purple-500" />
              )}
              {type === 'exam_session' && (
                <FileSpreadsheet className="h-5 w-5 text-green-500" />
              )}
              {dialogTitle}
            </NotionDialogTitle>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => onOpenChange(false)} className="!rounded-full !p-1 hover:bg-accent" aria-label="close">
              <X className="h-4 w-4 text-muted-foreground" />
            </NotionButton>
          </div>
        </NotionDialogHeader>

        {/* 搜索框 */}
        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('notes:reference.searchPlaceholder')}
              className={cn(
                'w-full h-10 pl-9 pr-4 rounded-lg',
                'bg-muted/50 border border-border',
                'text-sm text-foreground placeholder:text-muted-foreground',
                'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-transparent',
                'transition-colors'
              )}
            />
            {searchQuery && (
              <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 !p-0.5 !rounded-full hover:bg-accent" aria-label="clear">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </NotionButton>
            )}
          </div>
        </div>

        {/* 列表区域 */}
        <div className="border-t border-border">
          <CustomScrollArea
            className="h-[320px]"
            viewportClassName="px-4 py-2"
          >
            {loading ? (
              // 加载状态
              <div className="flex flex-col items-center justify-center h-full py-12">
                <Loader2 className="h-8 w-8 text-primary animate-spin" />
                <p className="mt-2 text-sm text-muted-foreground">
                  {t('common:loading')}
                </p>
              </div>
            ) : error ? (
              // 错误状态
              <div className="flex flex-col items-center justify-center h-full py-12">
                <AlertCircle className="h-8 w-8 text-destructive" />
                <p className="mt-2 text-sm text-destructive">{error}</p>
                <NotionButton variant="ghost" size="sm" onClick={loadData} className="mt-3 text-sm text-primary hover:underline">
                  {t('common:actions.retry')}
                </NotionButton>
              </div>
            ) : items.length === 0 ? (
              // 空状态
              <div className="flex flex-col items-center justify-center h-full py-12">
                {type === 'textbook' && (
                  <BookOpen className="h-12 w-12 text-muted-foreground/30" />
                )}
                {type === 'exam_session' && (
                  <FileSpreadsheet className="h-12 w-12 text-muted-foreground/30" />
                )}
                <p className="mt-3 text-sm text-muted-foreground">{emptyText}</p>
              </div>
            ) : (
              // 列表
              <div className="space-y-1">
                {items.map((item) => (
                  <ReferenceSelectorItem
                    key={item.id}
                    item={item}
                    isReferenced={existingRefIds.has(item.id)}
                    isSelected={selectedId === item.id}
                    onClick={() => handleSelect(item)}
                  />
                ))}
              </div>
            )}
          </CustomScrollArea>
        </div>

        {/* 底部操作栏 */}
        <div className="border-t border-border px-4 py-3 flex items-center justify-between bg-muted/30">
          <div className="text-xs text-muted-foreground">
            {items.length > 0 && (
              <>
                {t('notes:reference.itemCount', { count: items.length })}
                {existingRefIds.size > 0 && (
                  <span className="ml-2">
                    ({t('notes:reference.referencedCount', { count: existingRefIds.size })})
                  </span>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <NotionButton variant="default" size="sm" onClick={() => onOpenChange(false)} className="text-muted-foreground hover:text-foreground hover:bg-accent">
              {t('common:cancel')}
            </NotionButton>
            <NotionButton variant="primary" size="sm" onClick={handleConfirm} disabled={!selectedId} className="font-medium">
              {t('notes:reference.confirm')}
            </NotionButton>
          </div>
        </div>
    </NotionDialog>
  );
};

export default ReferenceSelector;
