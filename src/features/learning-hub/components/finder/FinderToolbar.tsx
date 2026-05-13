import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  List,
  Grid,
  RefreshCw,
  Plus,
  FolderPlus,
  FileText,
  ClipboardList,
  BookOpen,
  Languages,
  PenTool,
  Workflow,
} from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/shad/Breadcrumb';

interface FinderToolbarProps {
  breadcrumbs: { id: string; name: string }[];
  onBreadcrumbClick: (index: number) => void;
  /** 当前视图标题（用于智能文件夹模式，如"全部笔记"） */
  currentTitle?: string;
  /** 返回根目录回调 */
  onNavigateHome?: () => void;
}

/**
 * 简化后的工具栏 - 显示面包屑导航或当前视图标题
 * 搜索框、新建按钮已移到 FinderQuickAccess 侧栏
 * 视图切换已移到底部状态栏
 * 
 * 使用 React.memo 优化，避免文件列表操作导致不必要的重渲染
 */
export const FinderToolbar = React.memo(function FinderToolbar({
  breadcrumbs,
  onBreadcrumbClick,
  currentTitle,
  onNavigateHome,
}: FinderToolbarProps) {
  const { t } = useTranslation();
  // 显示当前视图标题（智能文件夹模式）
  if (breadcrumbs.length === 0 && currentTitle) {
    return (
      <div className="flex items-center h-9 px-3 border-b bg-muted/30 select-none shrink-0">
        <Breadcrumb>
          <BreadcrumbList className="flex-nowrap whitespace-nowrap">
            <BreadcrumbItem>
              <BreadcrumbLink
                asChild
                className="cursor-pointer hover:underline text-sm text-muted-foreground"
                onClick={onNavigateHome}
              >
                <span>{t('learningHub:title')}</span>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-medium text-sm">
                {currentTitle}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    );
  }

  // 根目录时不显示面包屑栏
  if (breadcrumbs.length <= 1) {
    return null;
  }

  return (
    <div className="flex items-center h-9 px-3 border-b bg-muted/30 select-none shrink-0">
      <Breadcrumb>
        <BreadcrumbList className="flex-nowrap whitespace-nowrap">
          {breadcrumbs.map((crumb, index) => {
            const isLast = index === breadcrumbs.length - 1;
            return (
              <React.Fragment key={crumb.id || index}>
                <BreadcrumbItem>
                  {isLast ? (
                    <BreadcrumbPage className="font-medium truncate max-w-[200px] text-sm">
                      {crumb.name}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      asChild
                      className="cursor-pointer truncate max-w-[150px] hover:underline text-sm"
                      onClick={() => onBreadcrumbClick(index)}
                    >
                      <span>{crumb.name}</span>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!isLast && <BreadcrumbSeparator />}
              </React.Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
});
