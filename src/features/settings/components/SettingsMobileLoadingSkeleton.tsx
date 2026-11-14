import React from 'react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { SettingsSidebarCategory } from './useSettingsNavigation';

/**
 * 移动端设置首屏加载骨架（进入分区列表前的占位）。
 *
 * 结构与改造前 Settings.tsx 内的 loading 分支一致：只按分类数量铺骨架行，
 * 不读取任何分区状态，因此独立成组件后外壳无需再持有该段 JSX。
 */
export function SettingsMobileLoadingSkeleton({ categories }: { categories: SettingsSidebarCategory[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden text-foreground" data-settings-mobile-level="loading">
      <CustomScrollArea
        className="settings-mobile-sheet-body min-h-0 flex-1 w-full"
        viewportClassName="settings-mobile-sheet-scroll-viewport h-full"
      >
        <div className="space-y-5 px-4 pb-[calc(1.25rem+var(--mobile-safe-area-bottom,0px))] pt-4">
          <div className="h-11 w-full animate-pulse rounded-[14px] bg-muted" />
          <div className="overflow-hidden rounded-2xl border border-border/40 bg-background p-1">
            {categories.map((category) => (
              <div key={category.value} className="flex min-h-[72px] items-center gap-3 border-b border-border/30 px-3 last:border-b-0">
                <div className="h-6 w-6 animate-pulse rounded-md bg-muted" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-4 w-28 max-w-[60%] animate-pulse rounded bg-muted" />
                  <div className="h-3 w-44 max-w-[80%] animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </CustomScrollArea>
    </div>
  );
}
