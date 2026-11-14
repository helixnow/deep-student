/**
 * @deepstudent/ui —— UI 插件 SDK 的唯一入口（docs/plugins/FRONTEND.md；API 说明见同目录 README.md）。
 * 第三方插件只从这里（以及 react / react-dom / i18next）导入；宿主通过 import map 提供同一份单例。
 *
 * 这里导出的名字是稳定的公共 API（导出清单由 __tests__/public-api.test.ts 锁定）；内核内部模块不属于 SDK。
 */

// 插件定义
export { defineUiPlugin, BUILTIN_SLOTS } from '../ui-kernel/kernel';
export { definePlugin, defineSlot, contribution, contributeAll, createPluginStore, withPluginScope } from './plugin';
export type { PluginSpec, SlotContributionOf } from './plugin';
export { UI_KERNEL_API_VERSION, UI_PLATFORMS } from '../ui-kernel/meta';
export type {
  UiPlugin, UiPluginMeta, NormalizedUiPluginMeta, UiPluginOrigin, UiPluginInstallOptions, UiService, UiPlatformKind,
  UiPlatformHandle, UiNavigationRequest, UiNavigator, UiTranslate, UiTranslateOptions,
  PluginStorage, PluginStorageCell, PluginStore, PluginStoreInit, PluginStoreOptions,
  UiPluginErrorReport, UiErrorPhase, UiHostStatusHandle, HostAvailability, HostPluginState, UiContextMenuItemV1,
  UiDisposer, UiBuildKind, UiCommand, UiWorkbenchApp, UiChatBlock, UiChatEventHandler, UiChatMode, LazyContributionPoint,
  UiDegradedCode, UiDegradedInfo, UiEventTransport,
} from '../ui-kernel/kernel';
export type { UiPlatformInfo, UiPlatformOs } from '../ui-kernel/services/platform';

// 槽位
export type { SlotMap, SlotName, SlotValue } from '../ui-kernel/slot-map';
export type { SlotCardinality, SlotContribution, SlotDefinition, SlotEntry } from '../ui-kernel/slots';
export { SlotOutlet } from '../ui-kernel/outlet';
export type { SlotOutletProps, SlotOutletErrorInfo } from '../ui-kernel/outlet';
export { useSlot, useSlotEntry, useOptionalSlot } from '../ui-kernel/react';
export { invalidateShellViewComponent, isLazyShellView, resolveShellViewComponent } from '../ui-kernel/shell-view';

// 服务 hook（在插件组件内使用；<SlotOutlet> 或 withPluginScope 提供所属插件）
export { useT, usePlatform, useNavigate, usePluginStorage, usePluginStore, usePluginScope } from '../ui-kernel/react';
export type { UiPluginScopeValue } from '../ui-kernel/react';

// 官方槽位的值类型
export type { ShellNavItem, ShellNavLabel, ShellView, ShellViewContribution, ShellViewProps, ShellViewModule, LazyShellView, ShellVisibilityContext, ViewShell } from '../ui-kernel/contracts/shell';
export type {
  SettingsCategory, SettingsSearchDetail, SettingsSection, SettingsSectionPlacement, SettingsSectionRegistration, SettingsSectionRenderProps,
  SettingsVisibilityContext,
} from '../ui-kernel/contracts/settings';
export type { ChatToolResultContribution, ChatToolResultPlacement, ChatToolResultProps } from '../ui-kernel/contracts/chat';
export type {
  MarkdownPlugin, MarkdownPluginContribution, MarkdownRehypeContext, MarkdownRehypeContribution, MarkdownRemarkContext,
  MarkdownRemarkContribution,
} from '../ui-kernel/contracts/markdown';
export type { GenuiComponentContribution } from '../ui-kernel/contracts/genui';
export type { EditorExtensionContribution, EditorInstanceContext, EditorPurpose, EditorSlashMenuContribution, SlashMenuBuilder, SlashMenuItem } from '../ui-kernel/contracts/editor';
export type {
  EditorBlockMenuContribution, EditorBlockMenuRow, EditorBlockMenuSurface, EditorBlockMenuTarget,
  EditorSelectionToolbarContribution, SelectionToolbarBuilder, SelectionToolbarItem,
} from '../ui-kernel/contracts/editor';
export type {
  AppMenuContext, AppMenuContexts, AppMenuContribution, AppMenuContributionFor, AppMenuDesktop, AppMenuDisplayMode, AppMenuDock,
  AppMenuDockWindow, AppMenuId, AppMenuItem, AppMenuLaunchReason, AppMenuMaterialTier, AppMenuRow, AppMenuSeparator, AppMenuTranslate,
  AppMenuWallpaper, AppMenuWallpaperPreset, AppMenuWindow, AppMenuWorkbench,
} from '../ui-kernel/contracts/menu';
export type { AppMenuDesktopShortcut } from '../ui-kernel/contracts/menu';
export type { AppMenuFinderDesktop, AppMenuFinderDesktopRoot, AppMenuFinderDesktopShortcut, AppMenuFinderTab } from '../ui-kernel/contracts/menu';
export type {
  NotesTreeMenuActions, NotesTreeMenuContext, NotesTreeMenuItem, ResourceMenuContribution, ResourceMenuScope, ResourceOperation,
  ResourceTypeDefinition, ScopedResourceMenuContribution,
} from '../ui-kernel/contracts/content';

// 跨插件互操作协议 v1（语义锚点 URI、子资源摘录拖拽与反向链接图）
export {
  DS_ANCHOR_SCHEME,
  DS_ANCHOR_VERSION,
  DS_EXCERPT_MIME,
  fnv1a64Hex,
  formatAnchorShortLocator,
  isSemanticAnchorUri,
  parseSemanticAnchor,
  sanitizeExcerptDragPayload,
  serializeSemanticAnchor,
} from '../ui-kernel/contracts/interop';
export type {
  AnchorEdgeRecord,
  AnchorEdgeSourceKind,
  AnchorEdgeUpsertInput,
  CustomSemanticAnchor,
  EpubSemanticAnchor,
  ExcerptContentKind,
  ExcerptDragInput,
  ExcerptDragPayload,
  MediaSemanticAnchor,
  MindmapSemanticAnchor,
  NormalizedRect,
  NoteSemanticAnchor,
  PdfSemanticAnchor,
  QbankSemanticAnchor,
  SemanticAnchor,
  SemanticAnchorBase,
  SemanticAnchorKind,
} from '../ui-kernel/contracts/interop';
export { hasExcerptMime, readExcerptDrag, startExcerptDrag } from '../ui-kernel/services/excerpt-dnd';
export type { ExcerptDropTargetOptions, UiExcerptDndHandle } from '../ui-kernel/services/excerpt-dnd';
export type {
  AnchorEdgesAdapter,
  AnchorEdgesChangedDetail,
  AnchorMatchQuality,
  AnchorRevealContext,
  AnchorRevealHandler,
  AnchorRevealOptions,
  AnchorRevealOutcome,
  AnchorRevealResult,
  OpenAnchorAdapter,
  UiAnchorsHandle,
} from '../ui-kernel/services/anchors';

// 设计系统：插件界面只用这些组件与 CSS 变量，深浅色与主题色自动适配。
export { DsButton } from '../components/ui/DsButton';
export { DsDialog } from '../components/ui/DsDialog';
export { SegmentedControl } from '../components/ui/SegmentedControl';
