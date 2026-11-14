import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ScreenPosition } from '@/components/layout';
import { registerBackHandler, BACK_PRIORITY, hasOpenRadixOverlayBesides } from '@/app/navigation/androidBackCoordinator';
import type { SettingsRightPanelType } from './hookDepsTypes';

/**
 * 移动端 Settings 外壳状态：三屏滑动位置、右侧面板类型、两级导航与返回链。
 *
 * 这些状态只描述移动端外壳（哪一屏、返回到哪里），不承载任何分区数据，
 * 因此从 Settings.tsx 下沉到这里。右面板返回使用调用方提供的统一分区清理链。
 * 桌面端仍会实例化本 hook，但 isSmallScreen=false 时不注册返回键。
 */
export function useSettingsMobileShell({
  isSmallScreen,
  isActive,
  activeTab,
  handleSave,
  loading,
  configLoadedRef,
  onBack,
}: {
  isSmallScreen: boolean;
  isActive: boolean;
  activeTab: string;
  handleSave: (silent?: boolean) => Promise<void>;
  loading: boolean;
  configLoadedRef: MutableRefObject<boolean>;
  onBack: () => void;
}) {
  // 移动端三屏布局状态
  const [screenPosition, setScreenPosition] = useState<ScreenPosition>('center');
  // 右侧面板类型：用于统一管理移动端右侧滑动面板内容
  const [rightPanelType, setRightPanelType] = useState<SettingsRightPanelType>('none');
  // P0-1 移动端两级导航：分区列表态（iOS 式分组列表 + 搜索） / 分区内容态
  const [mobileNavView, setMobileNavView] = useState<'sections' | 'content'>('sections');
  const [mobileSearchQuery, setMobileSearchQuery] = useState('');
  // P1-6 移动端 API 配置页两级导航：供应商列表 → 供应商详情
  const [mobileVendorDetailOpen, setMobileVendorDetailOpen] = useState(false);

  // P0-1：移动端分区导航改为分组列表（chip rail 已移除）。
  // 切换分区时收起 API 配置页的供应商详情，保证再次进入时回到列表态。
  useEffect(() => {
    setMobileVendorDetailOpen(false);
  }, [activeTab]);

  const closeRightPanel = useCallback(() => {
    setRightPanelType('none');
    setScreenPosition('center');
  }, []);

  const handleMobileSettingsBack = useCallback((dismissRightPanel: () => void) => {
    if (screenPosition !== 'right') {
      // 左抽屉展开时先收起
      if (screenPosition === 'left') {
        setScreenPosition('center');
        return;
      }
      // P0-1 / P1-6 两级导航返回链：
      // 供应商详情 → 供应商列表 → 分区内容 → 分区列表 →（菜单键）应用导航抽屉
      if (mobileNavView === 'content') {
        if (activeTab === 'apis' && mobileVendorDetailOpen) {
          setMobileVendorDetailOpen(false);
          return;
        }
        setMobileNavView('sections');
        return;
      }
      setScreenPosition('left');
      return;
    }
    dismissRightPanel();
  }, [
    screenPosition,
    mobileNavView,
    activeTab,
    mobileVendorDetailOpen,
  ]);

  // 处理返回按钮，确保在返回前保存配置
  // 🔧 修复：仅在 config 成功加载后才保存，防止 loadConfig 失败时覆写后端真实配置
  const handleBack = useCallback(async () => {
    if (!loading && configLoadedRef.current) {
      await handleSave(true); // 静默保存
    }
    onBack();
  }, [handleSave, loading, onBack]);

  const handleMobileHeaderBack = useCallback((dismissRightPanel: () => void) => {
    if (screenPosition === 'center' && mobileNavView === 'sections') {
      // 分区列表态退出设置：走 handleBack 先静默保存再返回（与历史 Sheet 关闭路径一致）。
      void handleBack();
      return;
    }
    handleMobileSettingsBack(dismissRightPanel);
  }, [screenPosition, mobileNavView, handleBack, handleMobileSettingsBack]);

  // Android 返回键：设置两级导航逐级回退（供应商详情 → 供应商列表 → 分区内容 → 分区列表）。
  //
  // 必须注册在 overlay 档而非 view 档：移动端 Settings 整页是 Radix Sheet
  // （role="dialog" data-state="open"），协调器的 Radix Escape 兜底探测跑在
  // view 档之前且常驻命中本 Sheet——view 档 handler 永远轮不到，逐级回退失效。
  // overlay 档显式 handler 先于兜底探测执行（见 androidBackCoordinator 文件头），
  // 且同优先级后注册先执行：打开更晚的 DsDialog / 浮动编辑器等仍最先消费；
  // MobileSlidingLayout 的抽屉/右滑面板 handler 靠本 handler 在非中屏时返回
  // false 让行。上方叠着未显式注册的 Radix 浮层（shad/Select 下拉等）时同样
  // 让行，交给兜底探测先关浮层。分区列表态返回 false → 兜底探测派发 Escape
  // → Sheet onOpenChange → handleSheetBack 关闭整个 Sheet（回退链的最后一级）。
  // Settings 是 LRU 保活视图：必须 gate isActive，非活跃时注销 handler，否则会吞掉其他页面的返回键。
  const sheetContentRef = useRef<HTMLDivElement | null>(null);
  const settingsBackStateRef = useRef({ screenPosition, mobileNavView, activeTab, mobileVendorDetailOpen });
  settingsBackStateRef.current = { screenPosition, mobileNavView, activeTab, mobileVendorDetailOpen };
  useEffect(() => {
    if (!isSmallScreen || !isActive) return;
    return registerBackHandler(() => {
      if (hasOpenRadixOverlayBesides(sheetContentRef.current)) return false;
      const s = settingsBackStateRef.current;
      if (s.screenPosition !== 'center' || s.mobileNavView !== 'content') return false;
      if (s.activeTab === 'apis' && s.mobileVendorDetailOpen) {
        setMobileVendorDetailOpen(false);
      } else {
        setMobileNavView('sections');
      }
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isSmallScreen, isActive]);

  return {
    screenPosition,
    setScreenPosition,
    rightPanelType,
    setRightPanelType,
    mobileNavView,
    setMobileNavView,
    mobileSearchQuery,
    setMobileSearchQuery,
    mobileVendorDetailOpen,
    setMobileVendorDetailOpen,
    closeRightPanel,
    handleMobileSettingsBack,
    handleMobileHeaderBack,
    handleBack,
  };
}
