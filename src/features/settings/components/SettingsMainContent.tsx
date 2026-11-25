import React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TFunction } from 'i18next';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { CaretLeft } from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogDescription, DsDialogBody, DsDialogFooter } from '@/components/ui/DsDialog';
import { DsButton } from '@/components/ui/DsButton';
import { ShellViewSwitch } from '@/components/ui/ShellViewSwitch';
import { cn } from '@/lib/utils';
import type { SlotEntry } from '@/ui-kernel/slots';
import type { SettingsSection, SettingsSectionPlacement, SettingsSectionPropsFactories } from '@/ui-kernel/contracts/settings';
import { SectionContent } from '@/ui-plugins/official/settings/SectionContent';
import type { SettingsSidebarCategory } from './useSettingsNavigation';
import { SettingsCategoryHeader } from './SettingsCategoryHeader';
import { QuickSyncNowButton } from './QuickSyncNowButton';
import { SettingsMcpPreviewBody } from './SettingsMcpPreviewBody';
import { SettingsMcpPolicyDialog } from './SettingsMcpPolicyDialog';
import type { McpPolicyModalState, McpPreviewState } from './mcp-editor/types';
import type { SystemConfig } from './types';

const SettingsTabFallback = () => {
  const { t } = useTranslation(['settings']);
  return (
    <div
      className="wb-sys-skeleton min-h-[360px] w-full rounded-xl bg-muted/20"
      role="status"
      aria-label={t('settings:loading', { defaultValue: 'Loading settings' })}
    />
  );
};

/**
 * 设置页主内容区：分区头部 + 滚动容器 + 当前分区内容 + 全局 MCP 弹窗。
 *
 * 只做布局与分区渲染编排，分区数据仍由外壳通过 getProps 提供；
 * 桌面/移动两种承载方式共用同一份结构（mobilePageMode 控制内边距与滚动样式）。
 */
export function SettingsMainContent({
  activeTab,
  setActiveTab,
  activeCategory,
  activeSectionEntry,
  settingsNavigationId,
  mobilePageMode,
  mobileVendorDetailOpen,
  effectiveMobilePanelMode,
  isSmallScreen,
  isMobile,
  setSettingsScrollElement,
  sectionProps,
  t,
  mcpPreview,
  stripMcpPrefix,
  handleClosePreview,
  mcpPolicyModal,
  setMcpPolicyModal,
  renderMcpToolEditor,
  invoke,
  setConfig,
  onMobileBack,
  mobileTitle,
  mobileRightActions,
}: {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  activeCategory: SettingsSidebarCategory | undefined;
  activeSectionEntry: SlotEntry<SettingsSection> | undefined;
  settingsNavigationId: string;
  mobilePageMode: boolean;
  mobileVendorDetailOpen: boolean;
  effectiveMobilePanelMode: boolean;
  isSmallScreen: boolean;
  isMobile: boolean;
  setSettingsScrollElement: (el: HTMLDivElement | null) => void;
  sectionProps: SettingsSectionPropsFactories;
  t: TFunction;
  mcpPreview: McpPreviewState;
  stripMcpPrefix: (raw?: string | null) => string;
  handleClosePreview: () => void;
  mcpPolicyModal: McpPolicyModalState;
  setMcpPolicyModal: Dispatch<SetStateAction<McpPolicyModalState>>;
  renderMcpToolEditor: () => React.ReactNode;
  invoke: typeof tauriInvoke | null;
  setConfig: Dispatch<SetStateAction<SystemConfig>>;
  onMobileBack?: () => void;
  mobileTitle?: string;
  mobileRightActions?: React.ReactNode;
}) {
  const renderActiveSection = (placement: SettingsSectionPlacement) => {
    if (!activeSectionEntry || (activeSectionEntry.value.placement ?? 'main') !== placement) return null;
    return <SectionContent entry={activeSectionEntry} getProps={sectionProps} isMobile={isMobile} t={t} />;
  };

  return (
    <div
      id="settings-main-content"
      className={cn(
        'flex-1 min-w-0 h-full flex flex-col overflow-hidden max-w-full relative bg-[color:var(--shell-workspace-panel)]',
        mobilePageMode && 'settings-mobile-sheet-body text-foreground'
      )}
      data-slot={mobilePageMode ? 'mobile-settings-page-content' : undefined}
    >
        {mobilePageMode && onMobileBack && (
          <div
            data-testid="settings-mobile-subpage-header"
            className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/40 bg-[color:var(--shell-workspace-panel)] px-2 py-1"
          >
            <DsButton
              type="button"
              variant="ghost"
              size="md"
              data-testid="settings-mobile-back"
              aria-label={t('settings:a11y.back_to_settings', { defaultValue: 'Back to settings' })}
              onClick={onMobileBack}
              className="!h-11 !min-h-[44px] !min-w-[44px] shrink-0 gap-1 px-2 text-foreground"
            >
              <CaretLeft size={20} weight="regular" aria-hidden="true" />
              <span className="text-sm font-medium">{t('common:back', { defaultValue: 'Back' })}</span>
            </DsButton>
            {mobileTitle ? (
              <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
                {mobileTitle}
              </h1>
            ) : null}
            {mobileRightActions ? (
              <div className="flex shrink-0 items-center gap-1">
                {mobileRightActions}
              </div>
            ) : null}
          </div>
        )}
        {activeCategory && !(mobilePageMode && mobileVendorDetailOpen) && (
          <div className="shrink-0 px-4 pt-3 sm:px-5 sm:pt-4 lg:px-8">
            <div className="mx-auto w-full max-w-[72rem]">
              <SettingsCategoryHeader
                category={activeCategory}
                activeTab={activeTab}
                onTabChange={setActiveTab}
                idPrefix={settingsNavigationId}
                compact={mobilePageMode || isSmallScreen}
                actions={activeCategory.value === 'data' ? <QuickSyncNowButton /> : undefined}
              />
            </div>
          </div>
        )}
        {activeSectionEntry?.value.desktopHeadingKey && !mobilePageMode && (
          <div className="shrink-0 px-5 pt-5 lg:px-8">
            <h1 className="mx-auto w-full max-w-[72rem] text-xl font-semibold">{t(activeSectionEntry.value.desktopHeadingKey)}</h1>
          </div>
        )}
        <CustomScrollArea
          className={cn('min-h-0 flex-1 w-full max-w-full', mobilePageMode && 'scrollbar-none')}
          // OverlayScrollbars 会把 viewport 的 padding 强制写成 0，水平内边距必须放在内层。
          // viewportRef：虚拟化列表（SettingsVirtualList / ShortcutSettings）需要真实滚动元素。
          viewportRef={setSettingsScrollElement}
          trackOffsetTop={16}
          trackOffsetBottom={16}
          trackOffsetRight={0}
          viewportClassName={mobilePageMode ? 'settings-mobile-sheet-scroll-viewport' : undefined}
          style={{ textAlign: 'left' }}
        >
          <div
            className={cn(
              mobilePageMode
                ? 'px-5 pb-[calc(1.25rem+var(--mobile-safe-area-bottom,0px))] pt-4'
                : 'px-4 pb-6 pt-3 sm:px-5 sm:pt-4 md:px-5 md:pb-7 md:pt-5 lg:px-8',
              effectiveMobilePanelMode && !mobilePageMode && 'px-4 py-3 pb-[calc(1rem+var(--mobile-safe-area-bottom,env(safe-area-inset-bottom,0px)))]',
            )}
          >
          {/* 分区切换：左右对称进出，替代原先只有入场的整树重挂载 */}
          <ShellViewSwitch viewKey={activeTab} className="mx-auto w-full max-w-[72rem]">
            <React.Suspense fallback={<SettingsTabFallback />}>
            <div
              className="space-y-6"
              id={`${settingsNavigationId}-panel`}
              role={activeCategory && !(mobilePageMode && mobileVendorDetailOpen) ? 'tabpanel' : undefined}
              aria-labelledby={activeCategory && !(mobilePageMode && mobileVendorDetailOpen) ? `${settingsNavigationId}-tab-${activeTab}` : undefined}
              tabIndex={0}
            >
        {/* API配置管理 */}
        {renderActiveSection('before-preview')}

        {/* MCP 预览：桌面及 Workbench 嵌入态用 DsDialog；独立移动端由三屏右滑面板承载（见 SettingsMobileRightPanel） */}
        {!effectiveMobilePanelMode && (
          <DsDialog open={mcpPreview.open} onOpenChange={(open) => { if (!open) handleClosePreview(); }} maxWidth="max-w-3xl">
            <DsDialogHeader>
              <DsDialogTitle>{mcpPreview.serverName || t('settings:mcp.preview.default_title')}</DsDialogTitle>
              <DsDialogDescription>{t('settings:mcp.preview.description')}</DsDialogDescription>
              {mcpPreview.serverId && (
                <div className="mt-1 text-xs text-muted-foreground break-all">{t('settings:mcp.preview.id_label')}：{mcpPreview.serverId}</div>
              )}
            </DsDialogHeader>
            <DsDialogBody overlayScroll className="py-6" onWheel={(event) => event.stopPropagation()}>
              <SettingsMcpPreviewBody preview={mcpPreview} stripMcpPrefix={stripMcpPrefix} t={t} />
            </DsDialogBody>
            <DsDialogFooter>
              <DsButton variant="outline" size="sm" onClick={handleClosePreview} className="[@media(pointer:coarse)]:!min-h-11">{t('common:close')}</DsButton>
            </DsDialogFooter>
          </DsDialog>
        )}
        {/* 注册分区：保留其与全局 MCP 弹窗之间的原有位置 */}
        {renderActiveSection('main')}
        {/* MCP 工具编辑模态 */}
        {renderMcpToolEditor()}
        {/* MCP 全局安全策略模态 - 独立移动端通过右侧滑动面板渲染 */}
        <SettingsMcpPolicyDialog
          open={mcpPolicyModal.open}
          isSmallScreen={effectiveMobilePanelMode}
          policy={mcpPolicyModal}
          setPolicy={setMcpPolicyModal}
          invoke={invoke}
          setConfig={setConfig}
          t={t}
        />
        {/* 原快捷键 / 关于页位于全局编辑模态之后 */}
        {renderActiveSection('after-modals')}
            </div>
            </React.Suspense>
          </ShellViewSwitch>
          </div>
        </CustomScrollArea>
    </div>
  );
}
