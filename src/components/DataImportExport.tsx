import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cloud, Gauge, HardDrive, ShieldCheck } from '@phosphor-icons/react';
import { CustomScrollArea } from './custom-scroll-area';
import { useMobileHeader, MobileSlidingLayout } from '@/components/layout';
import { useDesktopHeader, useHasDesktopHeaderHost } from '@/components/layout/DesktopHeaderContext';
import { TITLEBAR_CONTROL_CLASS } from '@/components/layout/desktopTitlebarTokens';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { DsButton } from '@/components/ui/DsButton';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { SettingSection } from '@/features/settings/components/SettingsCommon';
import { DataChartsPanel } from './stats/DataChartsPanel';
import { TodayCommandCenter } from './dashboard/TodayCommandCenter';
import { openDataGovernanceSettings } from '@/utils/pendingSettingsTab';

interface DataImportExportProps {
  onClose?: () => void;
  embedded?: boolean;
  /** 显示模式：'all' 学习统计 + 数据治理入口，'stats' 嵌入设置统计页，'manage' 仅治理入口 */
  mode?: 'all' | 'stats' | 'manage';
  /** 移动端顶栏返回回调（兼容既有调用方；顶栏固定展示抽屉菜单） */
  onBack?: () => void;
}

const DataManagementContent: React.FC<{
  embedded: boolean;
  children: React.ReactNode;
}> = ({ embedded, children }) => {
  if (embedded) {
    return <div className="data-management-content embedded">{children}</div>;
  }

  return (
    <CustomScrollArea
      className="data-management-content"
      viewportClassName="data-management-viewport"
    >
      {children}
    </CustomScrollArea>
  );
};

/** 移动端抽屉壳：仅独立移动端视图启用，抽屉承载应用主导航 */
const MaybeMobileDrawerShell: React.FC<{
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}> = ({ enabled, open, onOpenChange, children }) => {
  if (!enabled) return <>{children}</>;

  return (
    <div className="absolute inset-0 overflow-hidden">
      <MobileSlidingLayout
        sidebar={<div aria-hidden className="h-0" />}
        sidebarOpen={open}
        onSidebarOpenChange={onOpenChange}
        sidebarWidth="auto"
        showSidebarAppNavigation
        showContentOverlay
        className="flex-1"
      >
        {children}
      </MobileSlidingLayout>
    </div>
  );
};

/**
 * 学习数据与统计总览页（`data-management` 路由 + 设置页 `mode="stats"` 复用）。
 *
 * 旧版备份/导入导出/云存储/对话导入/数据空间切换等重复或废弃实现已全部收口到
 * 「设置 → 数据与系统（DataGovernanceDashboard）」，本页聚焦今日学习指挥中心、
 * 统一统计图表（DataChartsPanel）与直达数据治理的快捷入口。
 */
export const DataImportExport: React.FC<DataImportExportProps> = ({
  embedded = false,
  mode = 'all',
  onBack,
}) => {
  const { t } = useTranslation(['data', 'common']);
  const { isSmallScreen } = useBreakpoint();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useMobileHeader(
    'data-management',
    {
      title: t('common:navigation.data_management'),
      showMenu: !embedded,
      onMenuClick: () => setSidebarOpen(true),
      rightActions: (
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={t('data:governance.title')}
          title={t('data:governance.title')}
          onClick={() => openDataGovernanceSettings('overview')}
        >
          <ShieldCheck size={18} />
        </DsButton>
      ),
    },
    [t, embedded, onBack],
    !embedded
  );

  const hasDesktopHeaderHost = useHasDesktopHeaderHost();
  useDesktopHeader(
    'data-management',
    {
      breadcrumbs: [{ id: 'data-root', label: t('common:navigation.data_management') }],
      actions: (
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => openDataGovernanceSettings('overview')}
          className={TITLEBAR_CONTROL_CLASS}
        >
          <ShieldCheck size={14} />
          <span>{t('data:governance.title')}</span>
        </DsButton>
      ),
    },
    [t],
    !embedded && !isSmallScreen && hasDesktopHeaderHost,
  );

  return (
    <>
      <style>
        {`
          .data-management-container {
            height: calc(100vh - var(--desktop-titlebar-height, 40px));
            display: flex;
            flex-direction: column;
            background-color: hsl(var(--background));
          }
          .data-management-container.embedded {
            height: auto;
            background-color: transparent;
          }
          .data-management-content {
            flex: 1;
            min-height: 0;
          }
          .data-management-viewport .data-management-inner {
            padding: 1rem 2rem 2rem;
          }
          @media (max-width: 767.98px) {
            .data-management-container {
              height: 100%;
            }
            .data-management-viewport .data-management-inner {
              padding: 16px 16px calc(2rem + var(--mobile-safe-area-bottom, 0px)) 16px;
            }
          }
          .data-management-content.embedded {
            overflow: visible;
            padding: 0;
          }
          .data-management-inner {
            max-width: 80rem;
            margin: 0 auto;
          }
        `}
      </style>
      <MaybeMobileDrawerShell
        enabled={!embedded && isSmallScreen}
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
      >
        <div className={`data-management-container ${embedded ? 'embedded' : ''}`}>
          <DataManagementContent embedded={embedded}>
            <div className="data-management-inner">
              {(mode === 'all' || mode === 'stats') &&
                (mode === 'stats' ? (
                  <SettingSection
                    title={t('data:statistics_section_title')}
                    description={t('data:statistics_section_subtitle')}
                    className="overflow-visible"
                    hideHeader
                  >
                    <DataChartsPanel />
                  </SettingSection>
                ) : (
                  <div className="space-y-6">
                    <TodayCommandCenter
                      onNavigate={(view) => {
                        dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view });
                      }}
                    />

                    <DataChartsPanel />
                  </div>
                ))}

              {(mode === 'all' || mode === 'manage') && (
                <section
                  data-testid="data-governance-gateway"
                  className="mt-6 rounded-2xl bg-muted p-4 sm:p-5"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                        <ShieldCheck size={18} className="shrink-0 text-primary" aria-hidden="true" />
                        <span>{t('data:governance.title')}</span>
                      </h2>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {t('data:management_section_subtitle')}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3.5 grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
                    <DsButton
                      variant="outline"
                      size="sm"
                      onClick={() => openDataGovernanceSettings('overview')}
                      className="justify-center rounded-xl border-border/70 bg-background/60 px-3 text-foreground hover:bg-background/90"
                    >
                      <Gauge size={14} className="mr-1.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{t('data:governance.tab_overview')}</span>
                    </DsButton>
                    <DsButton
                      variant="outline"
                      size="sm"
                      onClick={() => openDataGovernanceSettings('backup')}
                      className="justify-center rounded-xl border-border/70 bg-background/60 px-3 text-foreground hover:bg-background/90"
                    >
                      <HardDrive size={14} className="mr-1.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{t('data:governance.tab_backup')}</span>
                    </DsButton>
                    <DsButton
                      variant="outline"
                      size="sm"
                      onClick={() => openDataGovernanceSettings('sync')}
                      className="justify-center rounded-xl border-border/70 bg-background/60 px-3 text-foreground hover:bg-background/90"
                    >
                      <Cloud size={14} className="mr-1.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{t('data:governance.tab_sync')}</span>
                    </DsButton>
                  </div>
                </section>
              )}
            </div>
          </DataManagementContent>
        </div>
      </MaybeMobileDrawerShell>
    </>
  );
};
