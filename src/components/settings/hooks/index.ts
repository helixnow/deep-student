/**
 * Settings Hooks 导出
 */

export { useVendorSettings, type VendorSettingsState } from './useVendorSettings';
// ★ 图谱模块已废弃 - useIrecSettings 已移除
// export { useIrecSettings, type IrecSettingsState } from './useIrecSettings';
export { useMcpSettings, type McpSettingsState, type McpToolModalState, type McpPolicyModalState, type McpPreviewState, type McpCachedDetails, type McpToolDraft } from './useMcpSettings';
