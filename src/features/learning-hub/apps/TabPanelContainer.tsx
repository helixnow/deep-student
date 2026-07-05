/**
 * TabPanelContainer - 标签页面板保活容器
 *
 * 为每个已打开的标签页渲染一个 UnifiedAppPanel 实例，
 * 通过 display:none 隐藏非活跃标签页，保持其组件状态不丢失。
 *
 * 支持分屏模式：当 splitView 不为 null 时，左右双面板布局。
 */

import React, { lazy, Suspense, useCallback, useRef } from 'react';
import { CircleNotch, X, SidebarSimple, DotsSixVertical } from '@phosphor-icons/react';
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import type { OpenTab, SplitViewState } from '../types/tabs';
import { useTranslation } from 'react-i18next';

// 懒加载统一应用面板
const UnifiedAppPanel = lazy(() => import('./UnifiedAppPanel').then(m => ({ default: m.UnifiedAppPanel })));

/**
 * ★ 2026-06-12（审阅问题 M3）：保活实例上限。
 * 旧实现对所有打开的 tab 无条件 display:none 保活，几十个 PDF/编辑器
 * 同时驻留内存。现按 LRU 只保活最近使用的 N 个，其余卸载（重新激活时
 * 重建，状态由各自 store/后端持久化兜底）。
 */
const MAX_KEEPALIVE_TABS = 5;

// ============================================================================
// 类型定义
// ============================================================================

export interface TabPanelContainerProps {
  tabs: OpenTab[];
  activeTabId: string | null;
  splitView?: SplitViewState | null;
  onClose: (tabId: string) => void;
  onTitleChange: (tabId: string, title: string) => void;
  onCloseSplitView?: () => void;
  /** 各标签页重载计数，用于强制 remount UnifiedAppPanel */
  tabReloadKeys?: Record<string, number>;
  className?: string;
}

// ============================================================================
// 加载占位
// ============================================================================

const PanelLoading: React.FC<{ label?: string }> = ({ label }) => (
  <div className="flex items-center justify-center h-full w-full">
    <CircleNotch size={24} className="animate-spin text-muted-foreground" />
    {label && <span className="ml-2 text-muted-foreground">{label}</span>}
  </div>
);

// ============================================================================
// 组件实现
// ============================================================================

export const TabPanelContainer: React.FC<TabPanelContainerProps> = ({
  tabs, activeTabId, splitView, onClose, onTitleChange, onCloseSplitView, tabReloadKeys, className,
}) => {
  const { t } = useTranslation('common');

  const handleClose = useCallback((tabId: string) => onClose(tabId), [onClose]);
  const handleTitleChange = useCallback((tabId: string, title: string) => onTitleChange(tabId, title), [onTitleChange]);

  // LRU 记录：tabId → 最近活跃序号（数值越大越新）
  const lruRef = useRef<Map<string, number>>(new Map());
  const lruTickRef = useRef(0);

  if (activeTabId) {
    lruRef.current.set(activeTabId, ++lruTickRef.current);
  }
  if (splitView?.rightTabId) {
    lruRef.current.set(splitView.rightTabId, ++lruTickRef.current);
  }
  // 清理已关闭 tab 的记录
  const openTabIds = new Set(tabs.map(tab => tab.tabId));
  for (const id of Array.from(lruRef.current.keys())) {
    if (!openTabIds.has(id)) lruRef.current.delete(id);
  }
  // 保活集合 = 最近使用的前 N 个（活跃 tab 与分屏 tab 序号最新，必然在内）
  const keepAliveIds = new Set(
    Array.from(lruRef.current.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_KEEPALIVE_TABS)
      .map(([id]) => id)
  );

  // 渲染单个 tab 面板内容（保活逻辑）
  const renderTabPanel = (tab: OpenTab, visible: boolean) => (
    <div
      key={tab.tabId}
      className="absolute inset-0"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      <Suspense fallback={<PanelLoading label={t('loading', '加载中...')} />}>
        <UnifiedAppPanel
          type={tab.type}
          resourceId={tab.resourceId}
          dstuPath={tab.dstuPath}
          onClose={() => handleClose(tab.tabId)}
          onTitleChange={(title) => handleTitleChange(tab.tabId, title)}
          isActive={visible}
          reloadNonce={tabReloadKeys?.[tab.tabId] ?? 0}
          className="h-full w-full"
        />
      </Suspense>
    </div>
  );

  // ★ F7 修复：普通模式与分屏模式共用同一棵 PanelGroup 树。
  // 之前两种模式返回不同的根结构（div vs PanelGroup），开/关分屏会让
  // 所有保活 tab 卸载重建——编辑器光标/撤销历史/滚动位置全部丢失，
  // 未保存草稿也要依赖卸载兜底保存。现在仅被分屏的那个 tab 移动容器，
  // 其余 tab 实例完全保留。
  const rightTab = splitView ? tabs.find(t => t.tabId === splitView.rightTabId) : undefined;

  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId="learning-hub-split-view"
      className={cn('h-full', className)}
    >
      {/* 左侧面板：普通模式下占满全宽 */}
      <Panel defaultSize={splitView ? 50 : 100} minSize={25} id="split-left" order={1}>
        <div className="relative h-full">
          {/* ★ Y3 修复：右侧分屏 tab 不在左侧重复渲染。
              之前左侧 map 中包含右侧 tab 的隐藏实例，导致同一资源双实例
              （重复加载、重复事件监听、编辑器互相干扰） */}
          {/* ★ M3：超出 LRU 保活上限的 tab 直接卸载，不再隐藏驻留 */}
          {tabs
            .filter(tab => !splitView || tab.tabId !== splitView.rightTabId)
            .filter(tab => keepAliveIds.has(tab.tabId) || tab.tabId === activeTabId)
            .map(tab => renderTabPanel(tab, tab.tabId === activeTabId))}
        </div>
      </Panel>

      {splitView && (
        <>
          {/* 分隔条 */}
          <PanelResizeHandle className="w-1.5 bg-border/50 hover:bg-primary/30 active:bg-primary/50 transition-colors flex items-center justify-center group">
            <DotsSixVertical size={12} className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
          </PanelResizeHandle>

          {/* 右侧面板：分屏 tab */}
          <Panel defaultSize={50} minSize={25} id="split-right" order={2}>
            <div className="relative h-full">
              {/* 右侧面板顶部关闭按钮 */}
              <div className="absolute top-2 right-4 z-10 flex items-center gap-2">
                <div className="bg-background/80 backdrop-blur-sm shadow-sm border border-border rounded-md px-2 py-1 text-xs text-muted-foreground font-medium flex items-center gap-1.5">
                  <SidebarSimple size={14} />
                  {t('learningHub:splitView.title', '分屏视图')}
                </div>
                <button
                  onClick={onCloseSplitView}
                  className="p-1.5 rounded-md bg-background/80 backdrop-blur-sm border border-border hover:bg-[var(--interactive-hover)] text-muted-foreground hover:text-foreground transition-all shadow-sm"
                  title={t('actions.close', '关闭分屏')}
                >
                  <X size={14} />
                </button>
              </div>
              {rightTab ? renderTabPanel(rightTab, true) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  {t('noContent', '无内容')}
                </div>
              )}
            </div>
          </Panel>
        </>
      )}
    </PanelGroup>
  );
};
