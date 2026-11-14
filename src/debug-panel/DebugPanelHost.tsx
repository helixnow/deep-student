import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { toggleDevtools } from '@/dev/devtools';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { Minus, ArrowsOut, X } from '@phosphor-icons/react';
import { useOptionalUiKernel } from '@/ui-kernel/react';
import { debugMasterSwitch } from './debugMasterSwitch';
import { useUILabToggle } from '../utils/uiLabToggle';
import type { DebugPanelHostProps } from '@/ui-plugins/official/debug/api';
import { HOME_PLUGIN_ID, PLUGIN_GROUPS, useDebugPanels } from './host/panelList';
import { CommunityPanel } from './host/CommunityPanel';
import { useFloatingFrame } from './host/useFloatingFrame';
import { usePanelPreferences } from './host/usePanelPreferences';

export type { DebugPanel, DebugPanelHostProps, DebugPanelPluginProps } from '@/ui-plugins/official/debug/api';

// 面板只在开发构建中存在（`debug.panels`）：生产构建里这一行连同 `./plugins` 一起被消除。
// 因此生产构建的 Analysis Panel 是空的（已接受，INTEGRATION-NOTES 11:45）：FE-B7 要求生产包不含任何
// `debug-panel/plugins/**` 模块；官方面板只能经 `./panels` 宣告，`dstu.ui.debug` 是 `meta.devOnly`，生产里不安装，
// `debug.panels` 槽位也就不存在。宿主仍可打开（设置页、命令面板、`DSTU_OPEN_DEBUGGER`、开启调试时的 Alt/Ctrl+Shift+D），
// 只剩标题栏（LLM Playground、DevTools、日志开关、UI Lab）和没有卡片的首页。证据：__tests__/debugPanelProduction.test.tsx。
if (import.meta.env.DEV) await import('./panels');

const DebugPanelHost: React.FC<DebugPanelHostProps> = ({ visible, onClose, currentStreamId }) => {
  // RUST-FIX(RF-W09-debug-panel-host-copy-localized): Rust 把标题栏几处提示与 UI Lab 开关文字写死为中文，英文界面也显示中文
  const { t } = useTranslation('common');
  const panels = useDebugPanels();
  const kernel = useOptionalUiKernel();
  const [portalEl, setPortalEl] = React.useState<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = React.useState(false);
  const { pos, setPos, size, setSize, setDragging, setResizing, dragStart, sizeStart } = useFloatingFrame();

  const [activePluginId, setActivePluginId] = React.useState<string>(HOME_PLUGIN_ID);
  const [searchQuery, setSearchQuery] = React.useState('');
  const { favoriteIds, activatedIds, toggleFavorite, activatePlugin } = usePanelPreferences();

  // 调试总开关状态
  const [masterSwitchEnabled, setMasterSwitchEnabled] = React.useState(() => debugMasterSwitch.isEnabled());

  // 监听总开关变化
  React.useEffect(() => {
    const unsubscribe = debugMasterSwitch.addListener((enabled) => {
      setMasterSwitchEnabled(enabled);
    });
    return unsubscribe;
  }, []);

  const handleToggleMasterSwitch = React.useCallback(() => {
    debugMasterSwitch.toggle();
  }, []);

  const [uiLabEnabled, toggleUILab] = useUILabToggle();

  // 支持程序化选择插件（通过 URL 参数或 localStorage）；面板晚到时（社区面板）到达后再选一次
  const pluginRequestHandled = React.useRef(false);
  React.useEffect(() => {
    if (pluginRequestHandled.current) return;
    const urlParams = new URLSearchParams(window.location.search);
    const targetPlugin = urlParams.get('debug-plugin') || localStorage.getItem('DSTU_DEBUG_PLUGIN');
    
    if (targetPlugin && targetPlugin !== HOME_PLUGIN_ID) {
      const pluginExists = panels.some(p => p.id === targetPlugin);
      if (pluginExists) {
        pluginRequestHandled.current = true;
        setActivePluginId(targetPlugin);
        activatePlugin(targetPlugin);
        // 清除 localStorage 标记（避免持久影响）
        localStorage.removeItem('DSTU_DEBUG_PLUGIN');
      }
    }
  }, [activatePlugin, panels]);

  // 当切换插件时自动记录激活态
  React.useEffect(() => {
    if (activePluginId && activePluginId !== HOME_PLUGIN_ID) {
      activatePlugin(activePluginId);
    }
  }, [activePluginId, activatePlugin]);

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'dstu-debugger-portal';
    el.style.position = 'relative';
    el.style.zIndex = '2147483647';
    document.body.appendChild(el);
    setPortalEl(el);
    return () => {
      try {
        document.body.removeChild(el);
      } catch (e) {
        console.warn('[DebugPanel] portal 元素移除失败（可能已被外部移除）:', e);
      }
      setPortalEl(null);
    };
  }, []);

  const pluginItems = React.useMemo(
    () =>
      panels.map(plugin => ({
        ...plugin,
        label: String(t(plugin.labelKey, plugin.labelDefault ?? plugin.labelKey)),
        description: String(t(plugin.descriptionKey, plugin.descriptionDefault ?? plugin.descriptionKey)),
      })),
    [panels, t],
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredPlugins = React.useMemo(
    () =>
      pluginItems.filter(plugin => {
        if (!normalizedQuery) return true;
        return (
          plugin.label.toLowerCase().includes(normalizedQuery) ||
          plugin.description.toLowerCase().includes(normalizedQuery)
        );
      }),
    [pluginItems, normalizedQuery],
  );

  const groupedPlugins = React.useMemo(
    () =>
      PLUGIN_GROUPS.map(group => {
        const items = filteredPlugins
          .filter(plugin => plugin.groupId === group.id)
          .sort((a, b) => {
            const aFav = favoriteIds.has(a.id);
            const bFav = favoriteIds.has(b.id);
            if (aFav !== bFav) {
              return aFav ? -1 : 1;
            }
            return a.label.localeCompare(b.label);
          });
        return { group, items };
      }).filter(group => group.items.length > 0),
    [filteredPlugins, favoriteIds],
  );

  const favoriteCount = favoriteIds.size;
  const visibleCount = filteredPlugins.length;

  // 只检查 portalEl，不检查 visible，确保面板保活
  if (!portalEl) {
    return null;
  }

  const isHome = activePluginId === HOME_PLUGIN_ID;

  const panel = (
    <div
      className="dstu-dbg-root fixed"
      style={{ 
        left: pos.x, 
        top: pos.y, 
        width: collapsed ? 'auto' : size.w, 
        height: collapsed ? 'auto' : size.h,
        display: visible ? 'block' : 'none',
        zIndex: 2147483647,
        transition: 'width 0.2s ease, height 0.2s ease',
      }}
    >
      <div className={`dstu-dbg flex flex-col ${collapsed ? '' : 'h-full'} bg-[hsl(var(--card)/0.97)] backdrop-blur-xl border border-[hsl(var(--border))] rounded-xl shadow-2xl shadow-[hsl(var(--foreground)/0.1)]`}>
        <div
          className={`dbg-header flex items-center justify-between px-3 py-2 ${collapsed ? '' : 'border-b border-[hsl(var(--border))]'} cursor-move bg-[hsl(var(--muted)/0.3)] rounded-t-xl ${collapsed ? 'rounded-b-xl' : ''}`}
          // touch-action:none：触摸拖动面板时不触发页面滚动
          style={{ touchAction: 'none' }}
          onPointerDown={ev => {
            // 仅鼠标左键 / 触摸 / 触控笔起手
            if (ev.pointerType === 'mouse' && ev.button !== 0) return;
            try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* 捕获失败不影响拖动（window 监听兜底） */ }
            setDragging(true);
            dragStart.current = { dx: ev.clientX - pos.x, dy: ev.clientY - pos.y };
          }}
          onDoubleClick={() => {
            if (collapsed) {
              setCollapsed(false);
            } else {
              setPos({ x: 12, y: 12 });
              setSize({ w: Math.min(720, Math.floor(window.innerWidth * 0.92)), h: Math.floor(window.innerHeight * 0.5) });
            }
          }}
        >
          <div className="flex items-center gap-2">
            <div className="text-xs font-semibold text-[hsl(var(--foreground))] tracking-tight">{t('debug_panel.title')}</div>
            {!collapsed && (
              <div className="inline-flex gap-1.5 ml-1 flex-wrap" onPointerDown={ev => ev.stopPropagation()}>
                <DsButton
                  onClick={() => setActivePluginId(HOME_PLUGIN_ID)}
                  variant={isHome ? 'primary' : 'ghost'}
                  size="sm"
                  className="text-[10px] h-6 px-2 [@media(pointer:coarse)]:min-h-11"
                >
                  {t('debug_panel.home')}
                </DsButton>
                <DsButton
                  onClick={() => {
                    dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'llm-playground' });
                  }}
                  variant="ghost"
                  size="sm"
                  className="text-[10px] h-6 px-2 [@media(pointer:coarse)]:min-h-11"
                  title={t('debug_panel.llm_playground_hint')}
                >
                  {t('debug_panel.llm_playground')}
                </DsButton>
                <DsButton
                  onClick={async () => {
                    const opened = await toggleDevtools();
                    if (opened === null) {
                      console.warn('[DebugPanel] DevTools 不可用：当前构建未启用 devtools');
                    }
                  }}
                  variant="ghost"
                  size="sm"
                  className="text-[10px] h-6 px-2 [@media(pointer:coarse)]:min-h-11"
                  title={t('debug_panel.devtools_hint')}
                >
                  DevTools
                </DsButton>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5" onPointerDown={ev => ev.stopPropagation()}>
            {!collapsed && (
              <>
              <DsButton
                onClick={handleToggleMasterSwitch}
                variant={masterSwitchEnabled ? 'success' : 'ghost'}
                size="sm"
                className="text-[10px] h-6 px-2 [@media(pointer:coarse)]:min-h-11"
                title={masterSwitchEnabled 
                  ? t('debug_panel.master_switch_on', '日志输出已开启，点击关闭') 
                  : t('debug_panel.master_switch_off', '日志输出已关闭，点击开启')
                }
              >
                {masterSwitchEnabled 
                  ? t('debug_panel.logs_on', '日志开') 
                  : t('debug_panel.logs_off', '日志关')
                }
              </DsButton>
              <DsButton
                onClick={toggleUILab}
                variant={uiLabEnabled ? 'warning' : 'ghost'}
                size="sm"
                className="text-[10px] h-6 px-2 [@media(pointer:coarse)]:min-h-11"
                title={uiLabEnabled
                  ? t('debug_panel.ui_lab_on_hint')
                  : t('debug_panel.ui_lab_off_hint')
                }
              >
                {uiLabEnabled ? t('debug_panel.ui_lab_on') : t('debug_panel.ui_lab_off')}
              </DsButton>
              </>
            )}
            {collapsed ? (
              <DsButton
                onClick={() => setCollapsed(false)}
                variant="ghost"
                size="sm"
                className="text-[10px] h-6 px-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                title={t('debug_panel.expand')}
              >
                <ArrowsOut size={12} />
              </DsButton>
            ) : (
              <DsButton
                onClick={() => setCollapsed(true)}
                variant="ghost"
                size="sm"
                className="text-[10px] h-6 px-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                title={t('debug_panel.minimize', '最小化')}
              >
                <Minus size={12} />
              </DsButton>
            )}
            {/* 关闭按钮：触屏没有 Alt+Shift+D 快捷键，必须有可点的关闭入口 */}
            <DsButton
              onClick={onClose}
              variant="ghost"
              size="sm"
              className="text-[10px] h-6 px-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
              title={t('debug_panel.close', '关闭')}
              aria-label={t('debug_panel.close', '关闭')}
            >
              <X size={12} />
            </DsButton>
          </div>
        </div>
        {!collapsed && (
          <>
            <div className="flex-1 flex flex-col overflow-auto" onPointerDown={ev => ev.stopPropagation()}>
          {isHome ? (
            <div className="flex-1 flex flex-col p-3 gap-3 bg-[hsl(var(--background))]">
              {!masterSwitchEnabled && (
                <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-[11px] text-orange-600 dark:text-orange-400">
                  {t('debug_panel.master_switch_off_hint', '调试总开关已关闭：所有插件已暂停运行（不会后台监听/刷日志）。需要调试时请先开启总开关。')}
                </div>
              )}
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <div className="relative flex-1">
                  <input
                    value={searchQuery}
                    onChange={ev => setSearchQuery(ev.target.value)}
                    placeholder={t('debug_panel.search_placeholder', '搜索插件或描述...')}
                    className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.3)] text-[hsl(var(--foreground))] text-sm [@media(pointer:coarse)]:text-[16px] px-3 py-2 pr-9 [@media(pointer:coarse)]:min-h-11 placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.4)] focus:border-[hsl(var(--primary)/0.4)] transition-shadow"
                  />
                  {searchQuery ? (
                    <button
                      type="button"
                      aria-label={t('debug_panel.search_clear', '清空搜索')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] px-2 py-1 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                      onClick={() => setSearchQuery('')}
                    >
                      ✕
                    </button>
                  ) : (
                    <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[hsl(var(--muted-foreground)/0.7)]">
                      {t('debug_panel.search_hint', '可按名称或描述搜索')}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] text-[hsl(var(--foreground)/0.8)]">
                    {t('debug_panel.total_plugins', { count: visibleCount })}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] text-[hsl(var(--foreground)/0.8)]">
                    {t('debug_panel.favorites_badge', { count: favoriteCount })}
                  </span>
                </div>
              </div>
              <div className="text-[11px] text-[hsl(var(--muted-foreground))] leading-snug">
                {t('debug_panel.favorite_hint')}
              </div>
              <div className="flex-1 flex flex-col gap-4 overflow-auto pr-1">
                {groupedPlugins.map(({ group, items }) => (
                  <div key={group.id} className="space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <div className="text-sm font-semibold text-[hsl(var(--foreground))] tracking-tight">
                          {t(group.labelKey)}
                        </div>
                        <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-snug">
                          {t(group.descriptionKey)}
                        </p>
                      </div>
                      <span className="text-[11px] px-2.5 py-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] text-[hsl(var(--foreground)/0.8)]">
                        {t('debug_panel.group_count', { count: items.length })}
                      </span>
                    </div>
                    {/* 列数按面板实际宽度（size.w）计算，而非视口断点——面板可被拖成窄条 */}
                    <div className={`grid gap-3 ${size.w >= 1100 ? 'grid-cols-3' : size.w >= 680 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                      {items.map(plugin => (
                        <div
                          key={`home-card-${plugin.id}`}
                          onClick={() => {
                            activatePlugin(plugin.id);
                            setActivePluginId(plugin.id);
                          }}
                          className="group relative rounded-xl border border-transparent ring-1 ring-border/40 p-3.5 bg-card hover:bg-card/80 flex flex-col gap-3 shadow-sm hover:shadow-md transition-[background-color,border-color,color,box-shadow] duration-200 cursor-pointer"
                        >
                          <button
                            type="button"
                            aria-label={
                              favoriteIds.has(plugin.id)
                                ? t('debug_panel.favorite_remove', '取消收藏')
                                : t('debug_panel.favorite_add', '收藏')
                            }
                            onClick={ev => {
                              ev.stopPropagation();
                              toggleFavorite(plugin.id);
                            }}
                            className={`absolute right-2.5 top-2.5 text-[13px] transition-colors [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 ${
                              favoriteIds.has(plugin.id)
                                ? 'text-warning drop-shadow-sm'
                                : 'text-[hsl(var(--muted-foreground)/0.5)] hover:text-[hsl(var(--muted-foreground))]'
                            }`}
                          >
                            {favoriteIds.has(plugin.id) ? '★' : '☆'}
                          </button>
                          <div className="relative space-y-1.5 pr-6">
                            <div className="flex items-start justify-between gap-2">
                              <h3 className="text-[13px] font-medium text-[hsl(var(--foreground))] leading-tight">
                                {plugin.label}
                              </h3>
                              {activatedIds.has(plugin.id) && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-success/10 text-success border border-success/30 font-medium">
                                  {t('debug_panel.activated_badge', '已激活')}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed line-clamp-3">
                              {plugin.description}
                            </p>
                          </div>
                          
                          <div className="relative flex gap-2 mt-auto pt-1">
                            <DsButton
                              onClick={ev => {
                                ev.stopPropagation();
                                toggleFavorite(plugin.id);
                              }}
                              variant={favoriteIds.has(plugin.id) ? 'warning' : 'ghost'}
                              size="sm"
                              className="text-[10px] h-7 min-w-[64px] [@media(pointer:coarse)]:min-h-11"
                            >
                              {favoriteIds.has(plugin.id)
                                ? t('debug_panel.favorite_short', '已收藏')
                                : t('debug_panel.favorite_action', '收藏')}
                            </DsButton>
                            <DsButton
                              onClick={ev => {
                                ev.stopPropagation();
                                activatePlugin(plugin.id);
                                setActivePluginId(plugin.id);
                              }}
                              variant="primary"
                              size="sm"
                              className="flex-1 text-[10px] h-7 [@media(pointer:coarse)]:min-h-11"
                            >
                              {t('debug_panel.open_plugin', '打开')}
                            </DsButton>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {groupedPlugins.length === 0 && (
                  <div className="flex items-center justify-center text-sm text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))] rounded-xl bg-[hsl(var(--muted)/0.2)] py-8">
                    {t('debug_panel.no_search_result', '未找到匹配的插件')}
                  </div>
                )}
              </div>
            </div>
          ) : (
            panels.map(plugin => {
              const PluginComponent = plugin.component;
              const isActive = activePluginId === plugin.id;
              const isActivated = activatedIds.has(plugin.id);
              // 性能保护：总开关关闭时，不渲染任何插件（包括“已激活”与当前打开的插件），
              // 以确保不会后台监听/刷日志影响输入性能。
              const shouldRender = masterSwitchEnabled && (isActive || isActivated);
              if (!shouldRender) return null;
              const show = isActive;
              const body = (
                <PluginComponent
                  visible={visible && show}
                  isActive={show}
                  isActivated={isActivated}
                  onClose={onClose}
                  currentStreamId={currentStreamId}
                />
              );
              return (
                <div key={plugin.id} className={`flex-1 ${show ? 'flex' : 'hidden'} flex-col overflow-auto`}>
                  {plugin.community ? (
                    <CommunityPanel scope={plugin.community} panelId={plugin.id} kernel={kernel}>{body}</CommunityPanel>
                  ) : body}
                </div>
              );
            })
          )}
        </div>
        {/* 缩放把手：外层为放大的命中区（28px，coarse 指针 44px），内层保留 12px 视觉角标 */}
        <div
          className="dbg-resize absolute right-0 bottom-0 flex h-7 w-7 cursor-nwse-resize items-end justify-end p-1.5 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
          style={{ touchAction: 'none' }}
          onPointerDown={ev => {
            if (ev.pointerType === 'mouse' && ev.button !== 0) return;
            ev.preventDefault();
            ev.stopPropagation();
            try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* 捕获失败不影响缩放（window 监听兜底） */ }
            setResizing(true);
            sizeStart.current = { sw: size.w, sh: size.h, sx: ev.clientX, sy: ev.clientY };
          }}
          title={t('debug_panel.resize_hint')}
        >
          <div className="h-3 w-3 rounded-br border-b-2 border-r-2 border-[hsl(var(--border))] transition-colors duration-200 hover:border-[hsl(var(--primary)/0.6)]" />
        </div>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(panel, portalEl);
};

export default DebugPanelHost;
