/**
 * 冻结边界 ③：业务插件编写接口。所有 lane 只依赖本文件与各服务的 api.ts。
 *
 * 插件就是 Cordis 插件（DSH 同机制）：`apply(ctx)` 中注册命令、提供服务、订阅事件；
 * 所有注册都是副作用，插件卸载时自动撤销。本文件只放**类型与零逻辑的工具函数**，
 * 实现在 host/kernel 的其他文件中（F1 负责）。
 *
 * 类型、常量与 `definePlugin` 定义在可移植入口 `core.ts`；本文件在其上再导出 kernel 的纯实现
 * （serde、primitives、agent-api 等）。运行时闭包同样不加载 Node 模块。iLink 渠道插件移到
 * `host/plugins/ilink/api.ts`，QR 编码移到 `host/platform/util/qr.ts`。
 *
 * 导出面有类型快照（`api.surface.txt`，tests/api-surface.test.ts）：任何导出的签名变化都会让测试失败，
 * 确认后用 `vitest -u` 更新快照并在提交中说明。标 `@stable` 的是社区插件可依赖的接口（插件生态 v1）：
 * 只做向后兼容的扩展；不兼容的修改先加 `@deprecated` 保留一个发布周期（`@typescript-eslint/no-deprecated`
 * 报出仍在使用的位置），再删除。
 */
export * from './core.ts';
/**
 * 插件 `Config` 用的 schema 库（`HostPlugin.Config`）。
 * @stable
 */
export { default as Schema } from '@deepseek-ai/schemastery';
export { ShellError } from './shell-error.ts';

/** Partial value-level serde diagnostics; not a JSON-text/from_str decoder (no source positions). */
export { serdeCheck, normalizeUnitEnums, rustDebugString, unexpectedOf } from './serde.ts';
export type { SerdeCheck, SchemaRefResolver } from './serde.ts';
export { decodeCapabilityFile, parseCapabilityFile, CapabilityDecodeError } from './capability-decode.ts';
export type { Capability, CapabilityPermission, CapabilityPlatform } from './capability-decode.ts';
export { Disposer, HookSet, HookKernel, Slot, SlotOccupied, Scope, ScopedPluginHost, ScopedPluginError } from './primitives.ts';
export type { GateDecision, ScopedPlugin } from './primitives.ts';
export { ToolDescriptor, ToolRegistry, ToolRegistryBuilder, ToolRegistryError, DescriptorTable, AgentServices, ServiceKey, ServiceNotFound, ToolExecutorBase, ExecutionContext, HostRequest, isCatchAllProvider, executorSensitivity, executorSensitivityForCall, executorHasDynamicSensitivity, executorConcurrencyClass, executorManagesCancellation, executorResultCharBudget, applyToolResultBudget, serializedCharLen, DEFAULT_TOOL_RESULT_CHAR_BUDGET, TRUNCATION_MARKER } from './agent-api.ts';
export type { ToolProvider, ProviderId, ToolExecutor, AgentToolCall, AgentToolResultInfo, CallIds, ExecutionFlags, RequestExt, ExecutionContextInit, HostBridge, AppEventEmitter, RuntimeRootResolver, ToolBlockStore, AdmittedToolDispatcher, ToolSensitivity, ToolConcurrency, ToolTimeout, HeadlessPolicy, PtcPolicy, ApprovalPolicy, AgentJson } from './agent-api.ts';
export { buildPipelineServices, missingDescriptorTools, verifyRosterCoverage } from './agent-wiring.ts';
export type { OptionalService, SpecificExecutorRegistry, RosterCoverageLogger } from './agent-wiring.ts';
export {
  APP_EXECUTOR_ROSTER, MissingExecutorError, PIPELINE_EXECUTOR_TAIL, WORKSPACE_COORDINATOR_GROUP,
  composeAppExecutorRoster, composePipelineExecutorRoster,
} from './agent-roster.ts';
export type {
  AppExecutorName, ExecutorRosterOptions, NamedExecutor, PipelineTailExecutorName, WorkspaceExecutorName,
} from './agent-roster.ts';
export {
  EXTENSION_PLUGIN_ORDER, ExtensionRegistry, disposeGlobalExtensions, registerExtensions,
} from './extensions.ts';
export type {
  ExtensionFailure, ExtensionInstaller, ExtensionInstallers, ExtensionLogger, ExtensionPluginName,
  ExtensionRegistration,
} from './extensions.ts';
export { PluginState, DEFAULT_PLUGIN_STATE, canTransitionTo, emptyStatusSnapshot } from './plugin-types.ts';
export type { PluginJsonValue, PluginKind, PluginDescriptor, PluginInfo, PluginStatusSnapshot, PluginSettings, PluginRuntimeContext, ChannelPlugin } from './plugin-types.ts';
export { PluginManager, asAppError } from './plugin-manager.ts';
export type { PluginManagerOptions } from './plugin-manager.ts';
export { STATE_CHANGED, QRCODE, ACTIVITY, createPluginEventSink } from './plugin-events.ts';
export type { StateChangedPayload, QrcodePayload, ActivityPayload, PluginEventSink } from './plugin-events.ts';
export { isBoundUser, RateLimiter } from './plugin-guard.ts';
