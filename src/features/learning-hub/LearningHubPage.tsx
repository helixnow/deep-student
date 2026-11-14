/**
 * Learning Hub 全屏页面
 *
 * 统一的资源访达 + 应用启动器。
 *
 * 设计原则：
 * - Learning Hub 负责管理所有类型资源的文件层级
 * - 点击资源时，打开对应的“原生应用”（笔记编辑器、教材查看器、题目集识别等）
 * - 原生应用只包含编辑/查看功能，不包含自己的文件管理侧边栏
 * - 侧边栏与应用面板之间支持拖拽调整大小
 *
 * 移动端适配：
 * - ★ 三屏滑动布局：左侧应用入口 ← 中间文件视图 → 右侧应用内容
 * - 手势滑动切换三屏，支持轴向锁定防止与竖直滚动冲突
 * - 打开资源时自动切换到右侧应用视图
 *
 * ★ Wave2-B r2（P4）：标签关闭统一走 contentDirtyRegistry 异步 close gate
 * （gate 本体在 ./closeTabGate.ts）。十四入口对照表（编号沿用
 * docs/dev/wave2-B-r1-anchor-hub.md §1）：
 *
 * | #     | 入口                          | 现落点（本轮后）                                  |
 * |-------|-------------------------------|---------------------------------------------------|
 * | 1-4   | TabBar 关钮/中键/键盘/右键关闭 | onClose=closeTabWithSplit → requestCloseTab（gate）|
 * | 5     | Cmd/Ctrl+W                    | closeTabWithSplit（gate + 分屏清理，不再裸 closeTab）|
 * | 6     | Finder 工具栏 handleCloseApp   | closeTabWithSplit（同上）                          |
 * | 7     | 右键「关闭其他」               | closeOtherTabs → requestCloseTabs（脏标签逐个确认，取消后不再弹框且脏标签保留；干净标签互不拖累）|
 * | 8     | 右键「关闭右侧」               | closeTabsToRight → 同上                            |
 * | 9     | openTab LRU 淘汰（MAX_TABS）   | 脏标签跳过淘汰（不弹框、不静默丢草稿，可暂超上限） |
 * | 10    | 保活实例淘汰（Container）      | TabPanelContainer keepAlive 集合豁免脏标签         |
 * | 11    | dstu deleted/purged 事件       | 豁免 gate（实体已删，保留原直删逻辑）              |
 * | 12    | 恢复后失效校验                 | r3 P8：按稳定 resourceId 校验，仅 NOT_FOUND 删标签 |
 * | 13    | 路由切走（Page unmount）       | 无法异步拦截；对注册了 save handler 的脏标签尽力 flush |
 * | 14    | 窗口关闭（beforeunload）       | 任一脏标签 → preventDefault（补齐非笔记类型）      |
 *
 * gate 语义：dirty → 三态确认（保存并关闭 / 丢弃 / 取消）；保存失败或取消
 * 一律保留标签与草稿（fail-closed）。确认对话框复用 workbench 的
 * ContentCloseConfirmationHost（本页自行挂载一份，portal 渲染）。
 */

import React from 'react';
import { MobileResourceMenuContext } from '@/components/layout/MobileResourceMenuContext';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { registerOpenResourceHandler, type OpenResourceHandler } from '@/dstu/openResource';
import type { DstuNode } from '@/dstu/types';
import { createEmpty, dstu, type CreatableResourceType } from '@/dstu';
import { LearningHubSidebar } from './LearningHubSidebar';
import type { ResourceListItem, ResourceType } from './types';
import { cn } from '@/lib/utils';
import { DotsSixVertical, SquaresFour } from '@phosphor-icons/react';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import {
  MobileSlidingLayout,
  MobileSubviewChromeProvider,
} from '@/components/layout';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useVfsContextInject, useLearningHubEvents } from './hooks';
import type {
  OpenExamEventDetail,
  OpenTranslationEventDetail,
  OpenEssayEventDetail,
  OpenNoteEventDetail,
  OpenResourceEventDetail,
  NavigateToKnowledgeEventDetail,
} from './hooks';
import { FINDER_HOST_IDS } from './stores/finderStore';
import { DstuAppLauncher } from './components/DstuAppLauncher';
import { type OpenTab, type SplitViewState, MAX_TABS, createTab } from './types/tabs';
import { TabBar } from './components/TabBar';
import { TabPanelContainer } from './apps/TabPanelContainer';
import { COMMAND_EVENTS, useCommandEvents } from '@/command-palette/hooks/useCommandEvents';
import {
  hasContentSaveHandler,
  saveContentNow,
} from '@/features/workbench/apps/content/contentDirtyRegistry';
import { ContentCloseConfirmationHost } from '@/features/workbench/apps/content/ContentCloseConfirmation';
import { confirmTabClose, isTabDirty, requestCloseTabs } from './closeTabGate';
import { NotesChromeSlotContext } from '@/features/notes/notesChromeSlot';
import {
  getQuickAccessTypeFromLauncherType,
  type QuickAccessType,
} from './learningHubContracts';

import { useLearningHubPageController } from './useLearningHubPageController';

export const LearningHubPage: React.FC = () => {
  const { activeAppType, activeSubviewChrome, activeTab, activeTabId, activeTabIdRef, appPanelRef, backNavStateRef, canInject, canInjectCurrentResource, canInjectCurrentResourceRef, centerViewTitle, closeOtherTabs, closeSplitView, closeTab, closeTabWithSplit, closeTabsToRight, commitCloseTabs, desktopShellHeaderTarget, desktopShellSidebarTarget, finderBreadcrumbs, finderCurrentPath, finderEnterFolder, finderGoUp, finderJumpToBreadcrumb, finderQuickAccessNavigate, finderQuickAccessType, finderRefresh, finderSearchQuery, finderSetSearchQuery, finderViewCapabilities, globalLeftPanelCollapsed, handleBreadcrumbNavigate, handleCloseApp, handleCloseAppRef, handleCreateAndOpen, handleInjectToChat, handleInjectToChatRef, handleNavigateToKnowledgeEvent, handleOpenApp, handleOpenEssayEvent, handleOpenExamEvent, handleOpenNoteEvent, handleOpenResourceEvent, handleOpenTranslationEvent, handleSidebarCollapsedChange, hasOpenApp, injectToChat, isInSubfolder, isInjecting, isLearningHubViewActive, isSmallScreen, localSidebarCollapsed, mobileGestureIgnoreSelector, mobileHeaderMenuOpen, mobileHeaderRightActions, navigateToMemory, notesChromeSlot, openActiveTabSettings, openSplitView, openTab, pendingCloseGateRef, pickNextActiveTab, prevHadTabsRef, requestCloseTab, requestCloseTabsBatch, resourceMenuContext, resourceMenuHost, restoredValidationDone, rootTitle, screenPosition, setActiveAppType, setActiveTabId, setIsFinderRefreshing, setLocalSidebarCollapsed, setMobileHeaderMenuOpen, setNotesChromeSlot, setResourceMenuHost, setScreenPosition, setSplitView, setTabReloadKeys, setTabs, sidebarCollapsed, sidebarPanelRef, splitView, splitViewRef, subviewChrome, subviewChromeHost, switchTab, t, tabReloadKeys, tabs, tabsRef, togglePinTab, updateTabTitle, useHostFinderStore } = useLearningHubPageController({ hasContentSaveHandler, saveContentNow });

  if (isSmallScreen) {
    return (
      // 子屏 chrome 接管通道只在移动分支提供：桌面分栏无统一顶栏，
      // 子屏探测不到宿主时保持页内自绘顶栏（useMobileSubviewChrome 返回 false）
      <MobileSubviewChromeProvider value={subviewChromeHost}>
      <MobileResourceMenuContext.Provider value={resourceMenuContext}>
      <div
        className="study-shell-page relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      >
        <MobileSlidingLayout
          className="min-h-0 flex-1"
          sidebarWidth="auto"
          screenPosition={screenPosition}
          onScreenPositionChange={setScreenPosition}
          rightPanelEnabled={!!activeTab}
          showContentOverlay
          showSidebarAppNavigation
          gestureIgnoreSelector={mobileGestureIgnoreSelector}
          sidebar={
            <DstuAppLauncher
              embedded
              activeType={activeAppType}
                onSelectApp={(type) => {
                  setActiveAppType(type);
                  // ★ 2026-01-19: 调用 finderStore 进行实际导航
                  // 映射 DstuAppLauncher 的类型到 finderStore 的 QuickAccessType
                  finderQuickAccessNavigate(getQuickAccessTypeFromLauncherType(type));
                  setScreenPosition('center');
                }}
                onCreateAndOpen={handleCreateAndOpen}
                // 📱 修复：之前未接线，抽屉里的「新建文件夹」点了没有任何反应。
                // 复用 LearningHubSidebar 已监听的命令事件（learningHub:create-folder）。
                onNewFolder={() => {
                  window.dispatchEvent(new CustomEvent('learningHub:create-folder'));
                }}
                onClose={() => setScreenPosition('center')}
                createDisabled={!finderViewCapabilities.canCreate}
                // 📱 修复：之前未接线 searchQuery/onSearchChange，抽屉搜索框输入无效
                searchQuery={finderSearchQuery}
                onSearchChange={finderSetSearchQuery}
                searchDisabled={!finderViewCapabilities.canSearch}
              />
          }
          rightPanel={
            <div className="study-shell-panel h-full min-h-0 overflow-hidden">
              {tabs.length > 0 ? (
                <div className="flex h-full min-h-0 flex-col overflow-hidden safe-area-bottom">
                  {/* ★ 移动端标签页栏：多 tab 可见、可切换、可关闭（修复"标签黑洞"） */}
                  <TabBar
                    tabs={tabs}
                    setTabs={setTabs}
                    activeTabId={activeTabId}
                    onSwitch={switchTab}
                    onClose={closeTabWithSplit}
                    onTogglePin={togglePinTab}
                    onCloseOthers={closeOtherTabs}
                    onCloseRight={closeTabsToRight}
                  />
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <TabPanelContainer
                      tabs={tabs}
                      activeTabId={activeTabId}
                      onClose={closeTabWithSplit}
                      onTitleChange={updateTabTitle}
                      tabReloadKeys={tabReloadKeys}
                      className="h-full"
                    />
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  <div className="text-center p-8">
                    <SquaresFour size={48} className="mx-auto mb-4 opacity-50" />
                    <p className="text-sm">{t('learningHub:selectResource')}</p>
                  </div>
                </div>
              )}
            </div>
          }
        >
          {/* 中间：文件视图 — 移动端与顶栏无缝衔接，不用 desktop pane 边框/阴影 */}
          <div
            className={cn(
              'h-full min-h-0 overflow-hidden',
              isSmallScreen ? 'bg-background' : 'study-shell-pane h-full',
            )}
          >
            <LearningHubSidebar
              mode="fullscreen"
              hostId={FINDER_HOST_IDS.pageMobile}
              sessionActive={isLearningHubViewActive && screenPosition === 'center'}
              // 📱 命令事件监听不能只在中屏开启：左抽屉「新建文件夹」是同步派发
              // learningHub:create-folder，此刻 screenPosition 仍为 'left'，
              // 若门控到 center 监听器尚未绑定，事件会被静默丢弃（点了没反应）。
              commandsEnabled={isLearningHubViewActive && screenPosition !== 'right'}
              onOpenPreview={handleOpenApp}
              onOpenApp={handleOpenApp}
              className="h-full overflow-hidden"
              isCollapsed={false}
              activeFileId={activeTab?.resourceId}
              hideToolbarAndNav={screenPosition !== 'center'}
            />
          </div>
        </MobileSlidingLayout>
        {/* ★ P4：close gate 确认对话框宿主（portal 渲染；workbench 桌面外
            requestContentCloseDecision 无宿主时恒返回 cancel，故本页自行挂载） */}
        <ContentCloseConfirmationHost />
      </div>
      </MobileResourceMenuContext.Provider>
      </MobileSubviewChromeProvider>
    );
  }

  // ========== 桌面端：分栏布局 ==========
  return (
    <div className="study-shell-page h-full min-h-0 w-full overflow-hidden">
      <PanelGroup
        direction="horizontal"
        className="h-full min-h-0"
        autoSaveId="learning-hub-layout"
      >
        {/* 左侧：资源访达（文件管理） */}
        <Panel
          ref={sidebarPanelRef}
          defaultSize={25}
          minSize={15}
          id="learning-hub-sidebar"
          order={1}
          className="h-full min-h-0 overflow-hidden"
        >
          <div className={cn("study-shell-pane h-full min-h-0 overflow-hidden", hasOpenApp && "border-r border-[color:var(--shell-workspace-border)]")}>
            <LearningHubSidebar
              mode="fullscreen"
              hostId={FINDER_HOST_IDS.page}
              sessionActive={isLearningHubViewActive}
              commandsEnabled={isLearningHubViewActive}
              onOpenPreview={handleOpenApp}
              onOpenApp={handleOpenApp}
              className="w-full h-full"
              isCollapsed={sidebarCollapsed}
              onToggleCollapse={() => handleSidebarCollapsedChange(!sidebarCollapsed)}
              activeFileId={activeTab?.resourceId}
              hasOpenApp={hasOpenApp}
              onCloseApp={handleCloseApp}
              quickAccessPortalTarget={desktopShellSidebarTarget}
              toolbarPortalTarget={desktopShellHeaderTarget}
              toolbarPortalMode="shell"
            />
          </div>
        </Panel>

        {/* 分隔条：仅在右侧面板可见时渲染，避免隐藏态仍占宽度。
            触屏热区走库内建 hitAreaMargins（coarse 19px → 6+2×19=44px），
            ::after 范式对 react-resizable-panels 的 rect 命中检测不生效 */}
        {hasOpenApp && (
          <PanelResizeHandle
            hitAreaMargins={{ coarse: 19, fine: 5 }}
            className="w-1.5 transition-colors flex items-center justify-center group bg-border hover:bg-primary/30 active:bg-primary/50"
          >
            <DotsSixVertical size={12} className="text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
          </PanelResizeHandle>
        )}

        {/* 右侧：原生应用面板（始终渲染，通过 collapsible 控制显示） */}
        <Panel
          ref={appPanelRef}
          defaultSize={75}
          minSize={40}
          collapsible={true}
          collapsedSize={0}
          id="learning-hub-app"
          order={2}
          className="h-full min-h-0 overflow-hidden"
        >
          {tabs.length > 0 && (
            <div className="study-shell-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
              {/* ★ 标签页栏 */}
              <TabBar
                tabs={tabs}
                setTabs={setTabs}
                activeTabId={activeTabId}
                onSwitch={switchTab}
                onClose={closeTabWithSplit}
                splitView={splitView}
                onSplitView={openSplitView}
                onCloseSplitView={closeSplitView}
                onTogglePin={togglePinTab}
                onCloseOthers={closeOtherTabs}
                onCloseRight={closeTabsToRight}
                actionsSlotRef={setNotesChromeSlot}
              />
              <div className="flex-1 min-h-0 overflow-hidden">
                {/* 笔记页面级操作并入标签栏右侧（单条顶栏）；分屏时两侧各自保留 chrome */}
                <NotesChromeSlotContext.Provider value={splitView || isSmallScreen ? null : notesChromeSlot}>
                  <TabPanelContainer
                    tabs={tabs}
                    activeTabId={activeTabId}
                    splitView={splitView}
                    onClose={closeTabWithSplit}
                    onTitleChange={updateTabTitle}
                    onCloseSplitView={closeSplitView}
                    className="h-full"
                  />
                </NotesChromeSlotContext.Provider>
              </div>
            </div>
          )}
        </Panel>
      </PanelGroup>
      {/* ★ P4：close gate 确认对话框宿主（同移动分支说明） */}
      <ContentCloseConfirmationHost />
    </div>
  );
};

export default LearningHubPage;
