/**
 * PageRefChips - PDF 页码引用 Chips 组件
 *
 * 在输入栏上方以单个标签形式显示用户在 PDF Viewer 中选中的页码。
 * 连续页码折叠为范围（如 1-3页），非连续页码用逗号分隔（如 1, 5, 8页）。
 * 发送消息时这些页码会以 [PDF@sourceId:page] 格式附加到消息中。
 */

import React, { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import type { PdfPageRefsState } from './usePdfPageRefs';

// ============================================================================
// 类型定义
// ============================================================================

export interface PageRefChipsProps {
  /** 页码引用状态 */
  pageRefs: PdfPageRefsState;
  /** 移除单个页码（保留接口，暂不使用） */
  onRemove: (page: number) => void;
  /** 清空所有页码 */
  onClearAll: () => void;
  /** 是否禁用交互 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 工具函数：将页码数组折叠为紧凑字符串
// ============================================================================

/**
 * 将已排序的页码数组折叠为紧凑表示
 *
 * 示例：
 *   [1, 2, 3]       → "1-3页"
 *   [1, 3, 5]       → "第1, 3, 5页"
 *   [1, 2, 3, 5, 7] → "1-3, 5, 7页"
 *   [5]             → "第5页"
 */
function formatPageRanges(pages: number[]): string {
  if (pages.length === 0) return '';
  if (pages.length === 1) return `第${pages[0]}页`;

  // 将连续页码分组为 [start, end] 范围
  const ranges: [number, number][] = [];
  let start = pages[0];
  let end = pages[0];

  for (let i = 1; i < pages.length; i++) {
    if (pages[i] === end + 1) {
      end = pages[i];
    } else {
      ranges.push([start, end]);
      start = pages[i];
      end = pages[i];
    }
  }
  ranges.push([start, end]);

  // 格式化每个范围
  const parts = ranges.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`));
  return parts.join(', ') + '页';
}

// ============================================================================
// 主组件
// ============================================================================

export const PageRefChips: React.FC<PageRefChipsProps> = memo(
  ({ pageRefs, onClearAll, disabled = false, className }) => {
    const { t } = useTranslation(['chatV2', 'common']);

    const label = useMemo(() => formatPageRanges(pageRefs.pages), [pageRefs.pages]);

    return (
      <div
        className={cn(
          'page-ref-chips flex items-center gap-1.5 px-2 py-1.5',
          className
        )}
      >
        {/* 单个标签：文件名 + 页码范围 */}
        <div
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-0.5',
            'rounded-full text-xs font-medium border border-transparent',
            'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
          )}
          title={`${pageRefs.sourceName} ${label}`}
        >
          <BookOpen size={12} className="shrink-0" />
          <span className="truncate max-w-[100px]">{pageRefs.sourceName}</span>
          <span className="opacity-60">·</span>
          <span className="whitespace-nowrap">{label}</span>
          {!disabled && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={onClearAll} className="-mr-0.5 !h-4 !w-4 !p-0 !rounded-full opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10" aria-label={t('chatV2:pageRef.clearAll')} title={t('chatV2:pageRef.clearAll')}>
              <X size={10} />
            </NotionButton>
          )}
        </div>
      </div>
    );
  }
);

PageRefChips.displayName = 'PageRefChips';

export default PageRefChips;
