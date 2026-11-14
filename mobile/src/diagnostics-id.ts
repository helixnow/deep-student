/**
 * 诊断插件（`worker/diagnostics-plugin.ts`）的 id，也是诊断页 `plugin:host|call` 的默认 `caller`：Host 只放行调用方插件
 * 自己提供的服务（SEC-E06），诊断页不是 UI 插件，用它所调服务 `mobileDiagnostics` 的提供方 id。
 * 主线程与 Worker 都导入这个模块，它不能带任何 Host 代码。
 */
export const MOBILE_DIAGNOSTICS_PLUGIN_ID = 'dstu.mobile.diagnostics';
