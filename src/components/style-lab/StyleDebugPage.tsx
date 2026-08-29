import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import { useMobileHeader, MobileSlidingLayout } from '@/components/layout';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { MigrationOverviewTab } from './MigrationOverviewTab';
import { ComponentCompareTab } from './ComponentCompareTab';
import { TokenInspectorTab } from './TokenInspectorTab';
import { MixedUsageTab } from './MixedUsageTab';
import { GenerativeUIDemoTab } from './GenerativeUIDemoTab';
import type { ScanData } from './types';
import scanDataJson from './scan-data.json';

const scanData = scanDataJson as ScanData;

/**
 * 样式调试台 — UI 迁移工作台
 *
 * 功能：
 * 1. 迁移概览：真实扫描数据驱动的组件采用率仪表盘
 * 2. 组件对比：Button / Switch / Tooltip / Toast 的目标 vs 遗留对比
 * 3. Token 校对：所有语义 CSS 变量的实时渲染和复制
 * 4. 混用清单：按组件族展示当前混用情况和涉及文件
 */
export function StyleDebugPage() {
  const { t } = useTranslation('sidebar');
  const { isSmallScreen } = useBreakpoint();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 移动端统一顶栏：标题 + 汉堡菜单（打开统一抽屉，与 AnkiTasksApp 同范式）
  useMobileHeader('ui-lab', {
    title: t('navigation.ui_lab'),
    showMenu: true,
    onMenuClick: sidebarOpen
      ? () => setSidebarOpen(false)
      : () => setSidebarOpen(true),
  }, [t, sidebarOpen]);

  const body = (
    <CustomScrollArea className="h-full">
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header — 移动端顶栏已展示标题，页内标题仅桌面渲染避免双标题 */}
        {!isSmallScreen && (
          <div className="mb-6">
            <h1 className="text-lg font-semibold text-[color:var(--text-primary)]">样式调试台</h1>
            <p className="text-sm text-[color:var(--text-secondary)] mt-1">
              UI 迁移工作台 — 数据来自真实代码扫描，非硬编码
            </p>
          </div>
        )}

        {/* Tabs */}
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="overview">迁移概览</TabsTrigger>
            <TabsTrigger value="compare">组件对比</TabsTrigger>
            <TabsTrigger value="tokens">Token 校对</TabsTrigger>
            <TabsTrigger value="mixed">混用清单</TabsTrigger>
            <TabsTrigger value="generative-ui">Generative UI</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <MigrationOverviewTab data={scanData} />
          </TabsContent>

          <TabsContent value="compare">
            <ComponentCompareTab />
          </TabsContent>

          <TabsContent value="tokens">
            <TokenInspectorTab />
          </TabsContent>

          <TabsContent value="mixed">
            <MixedUsageTab data={scanData} />
          </TabsContent>

          <TabsContent value="generative-ui">
            <GenerativeUIDemoTab />
          </TabsContent>
        </Tabs>
      </div>
    </CustomScrollArea>
  );

  if (!isSmallScreen) {
    return body;
  }

  // 移动端：统一滚动抽屉壳（照抄 AnkiTasksApp 的两屏范式）。
  // 本页无页内工具，抽屉只承载统一应用导航。
  return (
    <div className="absolute inset-0 overflow-hidden">
      <MobileSlidingLayout
        sidebar={<div aria-hidden className="h-0" />}
        sidebarOpen={sidebarOpen}
        onSidebarOpenChange={setSidebarOpen}
        sidebarWidth="auto"
        showSidebarAppNavigation
        showContentOverlay
        className="flex-1"
      >
        {body}
      </MobileSlidingLayout>
    </div>
  );
}

export default StyleDebugPage;
