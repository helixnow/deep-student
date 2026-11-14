/**
 * 插件管理（W35）公共出口。
 *
 * UI 组件只依赖 {@link PluginManagerController} 与 {@link PluginManagerAdapter}；
 * Host 命令名、参数与结果映射都留在适配器实现（W01），本目录不含任何命令字符串，
 * 也不直接调用 `invoke`。命令 SHA 发布后替换适配器即可接线。
 */
export { PluginManagerPanel } from './PluginManagerPanel';
export type { PluginManagerPanelProps } from './PluginManagerPanel';
export { registerPluginManagerWorkshop } from './workshop';
export type { PluginManagerWorkshop } from './workshop';

export { PluginRow } from './PluginRow';
export type { PluginRowProps } from './PluginRow';

export { DegradedReason } from './DegradedReason';
export type { DegradedReasonProps } from './DegradedReason';

export { ConsentDialog } from './ConsentDialog';
export type { ConsentDialogProps } from './ConsentDialog';

export { ConfigForm } from './ConfigForm';
export type { ConfigFormProps } from './ConfigForm';

export { InstallFeedback } from './InstallFeedback';
export type { InstallFeedbackProps } from './InstallFeedback';

export {
  PluginManagerController,
  usePluginManagerState,
  CONSENT_BUSY_KEY,
  PACKAGE_BUSY_KEY,
  pluginBusyKey,
} from './controller';
export type {
  PluginManagerConfigView,
  PluginManagerError,
  PluginManagerNotice,
  PluginManagerState,
} from './controller';

export { createPluginManagerSection, PLUGIN_MANAGER_SECTION_ID } from './mount';
export type { PluginManagerSectionOptions } from './mount';

export {
  pluginConfigForm,
  pluginConfigValues,
  validatePluginConfig,
  parseConfigNumber,
  EMPTY_CONFIG_FORM,
} from './config-schema';
export type {
  PluginConfigField,
  PluginConfigForm,
  PluginConfigIssue,
  PluginConfigIssueRule,
  PluginConfigOption,
} from './config-schema';

export {
  CONSENT_REQUIRED_KEY,
  DEGRADED_CODE_KEYS,
  autoUninstalled,
  degradeCodeLabel,
  degradedCodeKey,
  errorBudgetOf,
  parsePluginReason,
} from './reasons';
export type {
  ParsedPluginReason,
  PluginAutoUninstallReason,
  PluginErrorBudgetView,
} from './reasons';

export { usePluginErrorBudget } from './use-error-budget';

export {
  CONSENT_REQUIRED_CODE,
  pluginUiStatus,
} from './ui-status';
export type {
  PluginUiAvailability,
  PluginUiDegradedCode,
  PluginUiDegradedInfo,
  PluginUiHostState,
  PluginUiHostStatus,
  PluginUiStatusSnapshot,
} from './ui-status';
export { usePluginUiHostStatus } from './use-ui-status';

export type {
  ManagedPlugin,
  PluginConfigFieldIssue,
  PluginConfigSaveResult,
  PluginConfigSchemaMeta,
  PluginConfigSchemaNode,
  PluginConfigState,
  PluginConsentState,
  PluginConsentSubject,
  PluginDegradedState,
  PluginManagerAdapter,
  PluginManagerSnapshot,
  PluginOperationResult,
  PluginOrigin,
  PluginPackageResult,
  PluginPlatform,
  PluginRuntimeState,
} from './types';
