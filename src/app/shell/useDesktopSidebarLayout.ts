import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useUIStore } from '@/stores/uiStore';
import { isMacOS } from '@/utils/platform';
import { clearNativeTitlebarSidebarMaterial } from '@/utils/sidebarTranslucency';
import { useAndroidSafeArea } from '@/hooks/useAndroidSafeArea';
import {
  DESKTOP_SHELL,
  getShellSidebarDragLayout,
  getShellSidebarWidth,
  resolveShellSidebarResize,
  resolveShellTitlebarTopInset,
} from './desktopShell';
import { getMobileShellCssVars } from './mobileShell';

interface DesktopSidebarLayoutOptions {
  isSmallScreen: boolean;
  workbenchActive: boolean;
  /** from usePlatformSettingsSync */
  topbarTopMargin: number;
  /** only used for the accessibility labels of the toggle / resize handle */
  t: TFunction;
}

/**
 * 桌面壳侧栏的宽度、收起/展开动画与标题栏高度，连同 `app-shell` 的 CSS 变量。
 *
 * 拖拽期间直写 CSS 变量（关闭过渡），松手才落到 uiStore；收起时保留表面宽度到
 * 360ms 滑出结束，避免原生材质与自绘标题栏在过渡中间帧错位。
 * W38：从 App.tsx 原样搬出，判定与依赖不变。
 */
export function useDesktopSidebarLayout({
  isSmallScreen,
  workbenchActive,
  topbarTopMargin,
  t,
}: DesktopSidebarLayoutOptions) {
  const leftPanelCollapsed = useUIStore((state) => state.leftPanelCollapsed);
  const leftPanelWidth = useUIStore((state) => state.leftPanelWidth);
  const shellSidebarWidth = getShellSidebarWidth(
    isSmallScreen,
    leftPanelWidth,
    typeof window === 'undefined' ? undefined : window.innerWidth
  );
  const [desktopSidebarMotionWidth, setDesktopSidebarMotionWidth] = useState<number | null>(null);
  const desktopSidebarPresentationWidth = desktopSidebarMotionWidth ?? shellSidebarWidth;
  const desktopNavigationWidth = workbenchActive
    ? 0
    : !isSmallScreen && leftPanelCollapsed ? 0 : desktopSidebarPresentationWidth;
  const desktopSidebarTranslateX = !isSmallScreen && leftPanelCollapsed ? -desktopSidebarPresentationWidth : 0;
  // Keep the visual shell visible until the sidebar's 360ms slide-out ends.
  // Layout width can close immediately, but the native material must leave the
  // titlebar and sidebar on the same frame throughout the transition.
  const isDesktopSidebarSurfaceVisible =
    !isSmallScreen
    && !workbenchActive
    && (!leftPanelCollapsed || desktopSidebarMotionWidth !== null);
  const [isDesktopSidebarResizing, setIsDesktopSidebarResizing] = useState(false);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const desktopSidebarCollapsePendingRef = useRef(false);
  const androidSafeArea = useAndroidSafeArea();
  const shellTitlebarTopInset = resolveShellTitlebarTopInset({
    isSmallScreen,
    isMacOS: isMacOS(),
    manualTopMargin: topbarTopMargin,
    androidSafeAreaTop: androidSafeArea?.top ?? null,
  });
  // 工作台模式：顶栏只留原生/自绘窗口控制，不占内容高度
  const shellTitlebarOccupiedHeight = workbenchActive
    ? 0
    : DESKTOP_SHELL.titlebarBaseHeight + shellTitlebarTopInset;
  const desktopSidebarToggleLabel = t('common:navigation.toggle_sidebar');
  const desktopSidebarResizeLabel = t('common:navigation.resize_sidebar');

  const appShellCustomProperties = useMemo(() => ({
    ...getMobileShellCssVars(),
    '--sidebar-width': `${desktopNavigationWidth}px`,
    '--sidebar-expanded-width': `${desktopSidebarPresentationWidth}px`,
    '--sidebar-collapsed-width': `${desktopNavigationWidth}px`,
    '--shell-navigation-width': `${desktopNavigationWidth}px`,
    '--shell-sidebar-translate-x': `${desktopSidebarTranslateX}px`,
    '--shell-titlebar-height': `${shellTitlebarOccupiedHeight}px`,
    '--desktop-titlebar-height': `${shellTitlebarOccupiedHeight}px`,
    // 与 --shell-navigation-width 同值。该变量已注册为 <length> 自定义属性并挂在
    // app-shell 的 transition 上（app.css @property），标题栏深浅渐变分界随侧栏
    // 收起/展开逐帧联动；拖拽改宽期间由下方 setProperty 直写（过渡已被
    // data-sidebar-resizing 规则关闭），保证手柄拖动时即时跟随。
    '--shell-navigation-surface-width': `${desktopNavigationWidth}px`,
    '--shell-titlebar-content-height': `${workbenchActive ? 0 : DESKTOP_SHELL.titlebarBaseHeight}px`,
    '--topbar-safe-area': `${workbenchActive ? 0 : shellTitlebarTopInset}px`,
  }) as React.CSSProperties, [
    desktopNavigationWidth,
    desktopSidebarPresentationWidth,
    desktopSidebarTranslateX,
    shellTitlebarOccupiedHeight,
    shellTitlebarTopInset,
    workbenchActive,
  ]);

  useEffect(() => {
    if (!leftPanelCollapsed || desktopSidebarMotionWidth === null) return;

    const cleanupTimer = window.setTimeout(() => {
      setDesktopSidebarMotionWidth(null);
    }, 360);

    return () => window.clearTimeout(cleanupTimer);
  }, [desktopSidebarMotionWidth, leftPanelCollapsed]);

  const handleDesktopSidebarResizeStart = useCallback(() => {
    desktopSidebarCollapsePendingRef.current = false;
    setDesktopSidebarMotionWidth(null);
    setIsDesktopSidebarResizing(true);
  }, []);

  const handleDesktopSidebarResize = useCallback((requestedWidth: number) => {
    if (requestedWidth <= DESKTOP_SHELL.navigationCloseSnapWidth) {
      if (desktopSidebarCollapsePendingRef.current) return;

      desktopSidebarCollapsePendingRef.current = true;
      setDesktopSidebarMotionWidth(DESKTOP_SHELL.navigationMinWidth);
      appShellRef.current?.style.setProperty(
        '--shell-navigation-width',
        `${DESKTOP_SHELL.navigationMinWidth}px`
      );
      appShellRef.current?.style.setProperty(
        '--shell-navigation-surface-width',
        `${DESKTOP_SHELL.navigationMinWidth}px`
      );
      appShellRef.current?.style.setProperty(
        '--sidebar-expanded-width',
        `${DESKTOP_SHELL.navigationMinWidth}px`
      );
      appShellRef.current?.style.setProperty('--shell-sidebar-translate-x', '0px');
      setIsDesktopSidebarResizing(false);
      requestAnimationFrame(() => {
        desktopSidebarCollapsePendingRef.current = false;
        useUIStore.setState({
          leftPanelCollapsed: true,
          leftPanelWidth,
        });
      });
      return;
    }

    const layout = getShellSidebarDragLayout(
      requestedWidth,
      leftPanelWidth,
      typeof window === 'undefined' ? undefined : window.innerWidth
    );
    appShellRef.current?.style.setProperty('--shell-navigation-width', `${layout.trackWidth}px`);
    appShellRef.current?.style.setProperty('--shell-navigation-surface-width', `${layout.trackWidth}px`);
    appShellRef.current?.style.setProperty('--sidebar-expanded-width', `${layout.surfaceWidth}px`);
    appShellRef.current?.style.setProperty('--shell-sidebar-translate-x', `${layout.translateX}px`);
  }, [leftPanelWidth]);

  const handleDesktopSidebarResizeEnd = useCallback((requestedWidth: number) => {
    if (desktopSidebarCollapsePendingRef.current) return;

    const result = resolveShellSidebarResize(
      requestedWidth,
      leftPanelWidth,
      typeof window === 'undefined' ? undefined : window.innerWidth
    );

    setIsDesktopSidebarResizing(false);
    useUIStore.setState({
      leftPanelCollapsed: result.collapsed,
      leftPanelWidth: result.width,
    });
  }, [leftPanelWidth]);

  const toggleDesktopSidebar = useCallback(() => {
    // Preserve the current native surface width while the sidebar slides out.
    // Opening can reveal both layers immediately because the sidebar is already
    // at its target position when the collapsed state is removed.
    setDesktopSidebarMotionWidth(leftPanelCollapsed ? null : shellSidebarWidth);
    useUIStore.getState().toggleLeftPanel();
  }, [leftPanelCollapsed, shellSidebarWidth]);

  // 清理旧版本可能遗留的原生标题栏材质。标题栏左段现在与侧栏共用
  // WebView 背景，避免原生 NSVisualEffectView 覆盖自绘导航控件。
  useEffect(() => {
    if (!isSmallScreen && isMacOS()) {
      void clearNativeTitlebarSidebarMaterial();
    }
  }, [isSmallScreen]);

  return {
    leftPanelCollapsed,
    leftPanelWidth,
    shellSidebarWidth,
    desktopSidebarPresentationWidth,
    desktopNavigationWidth,
    isDesktopSidebarSurfaceVisible,
    isDesktopSidebarResizing,
    appShellRef,
    shellTitlebarTopInset,
    shellTitlebarOccupiedHeight,
    appShellCustomProperties,
    handleDesktopSidebarResizeStart,
    handleDesktopSidebarResize,
    handleDesktopSidebarResizeEnd,
    toggleDesktopSidebar,
    desktopSidebarToggleLabel,
    desktopSidebarResizeLabel,
  };
}
