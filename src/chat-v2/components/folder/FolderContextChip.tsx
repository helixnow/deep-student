/**
 * Chat V2 - FolderContextChip 文件夹上下文芯片
 *
 * 在输入栏上方显示已选择的文件夹
 *
 * 显示内容：
 * - 文件夹图标
 * - 文件夹名称（截断显示）
 * - 资源数量 Badge
 * - 删除按钮
 *
 * ★ 文档28改造：显示真实文件夹路径
 *
 * 数据契约来源：23-VFS文件夹架构与上下文注入改造任务分配.md Prompt 9
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { VfsFolder } from '@/dstu/types/folder';

// ============================================================================
// 类型定义
// ============================================================================

export interface FolderContextChipProps {
  /** 文件夹信息 */
  folder: VfsFolder;
  /** 文件夹内资源数量 */
  resourceCount: number;
  /** 移除回调 */
  onRemove: () => void;
  /** 是否禁用（流式生成中） */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** ★ 文档28改造：文件夹的真实路径（用于 tooltip 显示） */
  folderPath?: string;
}

// ============================================================================
// FolderContextChip 组件
// ============================================================================

export const FolderContextChip: React.FC<FolderContextChipProps> = ({
  folder,
  resourceCount,
  onRemove,
  disabled = false,
  className,
  folderPath,
}) => {
  const { t } = useTranslation('chatV2');

  // ★ 文档28改造：优先使用真实路径显示 tooltip
  const tooltipText = folderPath
    ? t('context.folderSelectedWithPath', '已选择文件夹 "{{name}}"（{{count}} 个资源）\n路径: {{path}}', {
        name: folder.title,
        count: resourceCount,
        path: folderPath,
      })
    : t('context.folderSelected', '已选择文件夹 "{{name}}"（{{count}} 个资源）', {
        name: folder.title,
        count: resourceCount,
      });

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full',
        'bg-amber-500/10 border border-amber-500/30',
        'text-sm transition-colors',
        disabled && 'opacity-60',
        className
      )}
      title={tooltipText}
    >
      {/* 文件夹图标 */}
      <Folder className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />

      {/* 文件夹名称 */}
      <span className="max-w-[120px] truncate text-foreground/90">
        {folder.title}
      </span>

      {/* 资源数量 Badge */}
      {resourceCount > 0 && (
        <span
          className={cn(
            'px-1.5 py-0.5 rounded-full text-xs font-medium',
            'bg-amber-500/20 text-amber-600 dark:text-amber-400'
          )}
        >
          {resourceCount}
        </span>
      )}

      {/* 删除按钮 */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) {
            onRemove();
          }
        }}
        disabled={disabled}
        className={cn(
          'p-0.5 rounded-full transition-colors',
          'hover:bg-amber-500/20',
          disabled && 'cursor-not-allowed'
        )}
        aria-label={t('common.remove', '移除')}
      >
        <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
      </button>
    </div>
  );
};

// ============================================================================
// FolderContextChipList 组件
// ============================================================================

export interface FolderContextChipListProps {
  /** 已选择的文件夹列表 */
  folders: Array<{
    folder: VfsFolder;
    resourceCount: number;
  }>;
  /** 移除某个文件夹的回调 */
  onRemove: (folderId: string) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
}

/**
 * 文件夹上下文芯片列表
 *
 * 显示多个已选择的文件夹
 */
export const FolderContextChipList: React.FC<FolderContextChipListProps> = ({
  folders,
  onRemove,
  disabled = false,
  className,
}) => {
  if (folders.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {folders.map(({ folder, resourceCount }) => (
        <FolderContextChip
          key={folder.id}
          folder={folder}
          resourceCount={resourceCount}
          onRemove={() => onRemove(folder.id)}
          disabled={disabled}
        />
      ))}
    </div>
  );
};

export default FolderContextChip;
