/**
 * 进程环境变量的可移植读取。
 *
 * 桌面（Electron 主进程）有 Node 的 `process.env`；移动端 worker 没有 `process`，
 * 一律按空环境处理——没有环境变量代理，也没有以环境变量打开的调试开关。
 * 新代码优先用平台服务（`ctx.app` / 插件配置）；这里只保留既有 Rust 迁移代码
 * 逐字读取同名环境变量的地方，避免为了读一个开关而改变行为。
 */
export type RuntimeEnvironment = Record<string, string | undefined>;

/** 当前运行时的环境变量表；没有 `process` 时为空对象。 */
export function runtimeEnvironment(): RuntimeEnvironment {
  return (globalThis as { process?: { env?: RuntimeEnvironment } }).process?.env ?? {};
}

/** 单个环境变量，未设置时为 undefined。 */
export function runtimeEnv(name: string): string | undefined {
  return runtimeEnvironment()[name];
}
