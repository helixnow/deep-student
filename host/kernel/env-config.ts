/**
 * 环境变量 → 插件配置。Rust 版在业务代码里直接读环境变量（每次调用读取）；Host 插件只读自己的配置，
 * 由桌面入口（`main.ts`）在启动时把这些开发开关映射成 profile 配置覆盖（`ProfileLoadOptions.configOverrides`）。
 * 环境变量在进程生命周期内不变，启动时读取与每次调用时读取等价。
 * 另有一个运行时开关 {@link HOST_CALL_CALLER_ENV}，不进插件配置，由入口传给 `HostRuntime`。
 */
import { DEFAULT_HOST_CALL_CALLER_MODE, type HostCallCallerMode } from './runtime.ts';

/** 环境变量 → `[插件 id, 配置键]`。 */
export const ENV_CONFIG_MAPPINGS: Readonly<Record<string, readonly [pluginId: string, key: string]>> = Object.freeze({
  /** dstu-research `hpias/service.rs:26`：`stub` / `retrieval` / 缺省或 `disabled`；原值透传，由插件按 Rust 语义解析。 */
  DEEP_STUDENT_HPIAS_BACKEND: ['dstu.memory', 'hpiasBackend'],
  /** `cloud_storage/webdav.rs:107-125`：坚果云每 30 分钟请求上限，`0` 关闭；原值透传，由插件按 Rust 语义解析与回退。 */
  DEEP_STUDENT_WEBDAV_RATE_LIMIT: ['dstu.sync-providers', 'webdavRateLimit'],
});

/** 设为 `require` 时 `plugin:host|call` 必须带 `caller`（SEC-E06）。 */
export const HOST_CALL_CALLER_ENV = 'DS_HOST_CALL_CALLER';

/** 只能收紧：`require` 之外的取值与未设置都用默认值，默认改为 `require` 后无法经环境变量放宽。 */
export function hostCallCallerMode(env: Readonly<Record<string, string | undefined>>): HostCallCallerMode {
  return env[HOST_CALL_CALLER_ENV] === 'require' ? 'require' : DEFAULT_HOST_CALL_CALLER_MODE;
}

/** 设置了的环境变量按 {@link ENV_CONFIG_MAPPINGS} 生成配置覆盖；未设置的不出现（不覆盖 profile 中的值）。 */
export function envConfigOverrides(env: Readonly<Record<string, string | undefined>>): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const [name, [pluginId, key]] of Object.entries(ENV_CONFIG_MAPPINGS)) {
    const value = env[name];
    if (value === undefined) continue;
    (overrides[pluginId] ??= {})[key] = value;
  }
  return overrides;
}
