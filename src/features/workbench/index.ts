/**
 * Workbench 模块唯一公共出口。
 *
 * 外部业务模块只允许从这里 import；不得深入 workbench 内部路径。
 */
export * from './core/types';
export { appRegistry } from './core/appRegistry';
export { workbenchBus } from './core/workbenchBus';
export { useWindowStore } from './core/windowStore';
export { useWindowLifecycle, recomputeLifecycles } from './core/scheduler';
export { computeTiledFrame } from './core/tiling';
// —— P2：指针交互引擎与平铺系统 ——
export {
  zoneToDisplayMode,
  clampTilingRatio,
  tilingPairKey,
  DEFAULT_TILE_MARGIN,
  MIN_TILING_RATIO,
  MAX_TILING_RATIO,
} from './core/tiling';
export { hitTestSnapZone, SNAP_EDGE_THRESHOLD, SNAP_CORNER_THRESHOLD } from './core/snapZones';
export {
  WindowPointerEngine,
  FALLBACK_MIN_SIZE,
  MOVE_KEEP_VISIBLE_X,
  MOVE_KEEP_VISIBLE_Y,
} from './core/pointerEngine';
export type { ResizeEdge, GestureKind, PointerEngineOptions } from './core/pointerEngine';
export { useWindowPointer } from './components/window-shell/useWindowPointer';
export type {
  UseWindowPointerOptions,
  UseWindowPointerResult,
} from './components/window-shell/useWindowPointer';
export { useTilingDivider } from './components/window-shell/useTilingDivider';
export type {
  UseTilingDividerOptions,
  UseTilingDividerResult,
} from './components/window-shell/useTilingDivider';
export { SnapPreview } from './components/SnapPreview';
export type { SnapPreviewProps } from './components/SnapPreview';

// ---- P3：窗口 chrome 与内容壳 ----
export { WindowShell, snapZoneToDisplayMode, useDefaultWindowPointer } from './components/WindowShell';
export type {
  WindowShellProps,
  WindowShellPointerHook,
  WindowShellPointerArgs,
  WindowShellPointerResult,
} from './components/WindowShell';
export { WindowTitleBar, TITLEBAR_HEIGHT } from './components/WindowTitleBar';
// 标题栏高度单一来源（TS 常量 + CSS token 名 + 子应用安全区 var() 写法）
export { TITLEBAR_HEIGHT_CSS_VAR, titlebarHeightCss } from './core/metrics';
export { TileMenuPopover, TILE_MENU_GRID } from './components/TileMenuPopover';
export type { TileMenuAction } from './components/TileMenuPopover';
export { WindowResizeHandles, RESIZE_DIRECTIONS } from './components/WindowResizeHandles';
export type { ResizeDirection } from './components/WindowResizeHandles';
export { WindowBody } from './components/WindowBody';
export { WindowErrorBoundary } from './components/WindowErrorBoundary';

// ---- P6：快捷键 / 俯瞰 / 切换器（追加导出） ----
export {
  listWorkbenchShortcuts,
  formatShortcutBinding,
  matchWorkbenchShortcut,
  isEditableTarget,
  computeCenteredFrame,
  useWorkbenchOverlay,
  WORKBENCH_SHORTCUT_DEFINITIONS,
} from './core/shortcuts';
export type {
  WorkbenchShortcutId,
  WorkbenchShortcutInfo,
  WorkbenchShortcutBinding,
  WorkbenchShortcutDefinition,
  WorkbenchOverlayState,
} from './core/shortcuts';
export { useWorkbenchShortcuts } from './hooks/useWorkbenchShortcuts';
export type { UseWorkbenchShortcutsOptions } from './hooks/useWorkbenchShortcuts';
export { ExposeOverlay, computeExposeLayout } from './components/ExposeOverlay';
export type { ExposeItem, ExposeTarget, ExposeLayoutOptions } from './components/ExposeOverlay';
export { WindowSwitcher } from './components/WindowSwitcher';

// ---- P7: Chat 应用（追加导出） ----
export {
  registerChatApp,
  chatAppDefinition,
  handleChatActivation,
  CHAT_APP_TYPE_ID,
} from './apps/chat/register';
export {
  launchNewChatSession,
  openChatSession,
  type LaunchNewChatSessionOptions,
  type LaunchNewChatSessionResult,
} from './apps/chat/newSession';
export { ChatSessionSurface, type ChatSessionSurfaceProps } from './apps/chat/ChatSessionSurface';

// ---- P9 追加：事件中枢 / 投射 / 系统应用群 ----
export {
  hubListen,
  hubListenKeyed,
  setHubKeyExtractor,
  defaultHubKeyExtractor,
  getEventHubDiagnostics,
  resetEventHub,
} from './core/eventHub';
export type { HubHandler, HubKeyExtractor, EventHubDiagnostics } from './core/eventHub';
export {
  registerProjectionSource,
  resyncProjections,
  getProjectedInstances,
  resetProjections,
} from './core/projection';
export type { ProjectionInstance, ProjectionSource } from './core/projection';
export { registerSystemApps } from './apps/system/register';
export { registerSystemProjections } from './apps/system/projections';
export { registerSandboxApp } from './apps/sandbox/register';
// —— P1 追加导出（内核完整版）——
export {
  startScheduler,
  getMemoryBudget,
  setMemoryBudgetOverride,
  DEFAULT_MEMORY_BUDGET,
  MACOS_MEMORY_BUDGET,
} from './core/scheduler';
export { computeOcclusion } from './core/occlusion';
export {
  saveSnapshot,
  flushSnapshot,
  loadSnapshot,
  sanitizeSnapshot,
  buildSnapshot,
  registerDockPinnedProvider,
  WORKBENCH_SNAPSHOT_KEY,
  SNAPSHOT_SAVE_DEBOUNCE_MS,
} from './core/snapshot';
export { WorkbenchDevPanel } from './components/WorkbenchDevPanel';
export {
  detectAutoMaterialTier,
  getMaterialTier,
  setMaterialTier,
  useMaterialTier,
} from './core/materialTier';
export type { MaterialTierSetting } from './core/materialTier';
export {
  attachLiquidGlassLens,
  bucketRadius,
  canUseLiquidGlassLens,
  detachLiquidGlassLens,
  getActiveLiquidGlassLensCount,
  getSharedDisplacementMap,
  syncLiquidGlassCapability,
  useLiquidGlassLens,
} from './core/liquidGlassLens';
export type { LensOptions } from './core/liquidGlassLens';
export {
  DEFAULT_WALLPAPER,
  WALLPAPER_PRESETS,
  WallpaperLayer,
} from './components/WallpaperLayer';
export type { WallpaperConfig, WallpaperPreset } from './components/WallpaperLayer';
export { EmptyDesktop } from './components/EmptyDesktop';

// ---- SB1：学习状态菜单栏 ----
export { StatusBar } from './components/StatusBar';
export { StatusBarItems, formatStatusBarTime } from './components/StatusBarItems';

// ---- L4：全部应用面板 ----
export { AppsPanel, APPS_PANEL_EXIT_MS } from './components/AppsPanel';
export type { AppsPanelProps } from './components/AppsPanel';
export {
  APPS_DOCK_TYPE_ID,
  openAppsPanel,
  closeAppsPanel,
  toggleAppsPanel,
  isAppsPanelOpen,
  useAppsPanelOpen,
} from './components/appsPanelStore';

// ---- 缝一：Workbench 停用事务（模式开关 / 应用退出统一逐窗预检） ----
export {
  runWorkbenchDeactivationTransaction,
  hasDirtyWorkbenchWindows,
  isWorkbenchDeactivationInFlight,
} from './core/deactivationTransaction';
export type {
  WorkbenchDeactivationReason,
  WorkbenchDeactivationResult,
} from './core/deactivationTransaction';

// ---- ACR：Agent Collaborator Runtime（R0.5 脚手架，见 docs/dev/acr/DESIGN.md） ----
export * from './agent/types';
export { stageManager } from './agent/stageManager';
export { usePresenceStore, useWindowPresence } from './agent/presenceStore';
export { agentFlash } from './agent/visuals/agentFlash';
export { registerDomainListener } from './agent/domainEvents';
