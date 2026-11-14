/**
 * `host/platform/errors` 的插件入口。
 *
 * 共享的错误类型与构造函数在 `api.ts`；云配置命令插件（`cloud_config_*`）在这里导出，
 * 由 Host profile 加载。`cloudConfig` 服务的实现由 L21/L23 提供（见 `cloud-config-api.ts`）。
 */
export { default } from './cloud-config-commands.ts';
export * from './api.ts';
export * from './cloud-config-api.ts';
