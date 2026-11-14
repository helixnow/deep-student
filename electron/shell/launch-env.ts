/**
 * 打包版的启动环境变量（SEC-E02）。
 *
 * {@link DEV_ONLY_ENV} 只供开发与测试，打包版在 main 读取任何配置之前从 `process.env` 删除（Host 的 utilityProcess
 * 继承 `process.env`，也就一并看不到）。它们能换掉 Host 入口与插件 profile（以应用身份执行任意代码）、把任意地址
 * 当作本地应用页面（拿到主窗口的 ACL）、换掉前端目录 / capability / migrations，或把主窗口截图写到任意路径。
 * 能设置用户环境变量的本地进程（`launchctl setenv`、Windows 用户环境变量、快捷方式）因此不能借已签名的应用运行
 * 自己的代码、继承它的系统授权——与 fuses 关掉 RunAsNode / NODE_OPTIONS 是同一个目的。
 *
 * {@link PACKAGED_ISOLATION_ENV} 在打包版保留：只把数据放到另一个目录，相当于 Tauri 版跟随 `$HOME` 定位数据目录
 * （dirs crate）；同一用户本来就能直接改写默认数据目录，重定向不增加能力。打包冒烟靠它们隔离用户正式数据，
 * 被测的是与发布完全相同的产物。
 */

/** macOS release main stub removes these before Node starts; JS handles other platforms. */
export const MAC_NATIVE_CACHE_ENV = Object.freeze(['NODE_COMPILE_CACHE', 'NODE_COMPILE_CACHE_PORTABLE'] as const);

export const DEV_ONLY_ENV = Object.freeze([
  'DS_HOST_ENTRY',
  'DS_HOST_PROFILE',
  'DS_ELECTRON_DEV_URL',
  'DS_ELECTRON_DEV_CONFIG',
  'DS_ELECTRON_FRONTEND_DIST',
  'DS_ELECTRON_CAPTURE',
  'DS_ELECTRON_CAPTURE_DELAY_MS',
  'DS_MIGRATIONS_DIR',
  'DS_CAPABILITIES_DIR',
  // Host 的 Node 编译缓存目录：缓存里是 Host 直接执行的字节码，打包版固定放在 userData 下（shell/host.ts）。
  ...MAC_NATIVE_CACHE_ENV,
] as const);

export const PACKAGED_ISOLATION_ENV = Object.freeze(['DS_APP_DATA_DIR', 'DS_ELECTRON_USER_DATA'] as const);

/** 打包版删除 `env` 中的 {@link DEV_ONLY_ENV}，返回实际被忽略的变量名（供主日志记录）；开发态不改动。 */
export function dropDevOnlyEnv(env: NodeJS.ProcessEnv, packaged: boolean): string[] {
  if (!packaged) return [];
  const ignored = DEV_ONLY_ENV.filter((name) => env[name] !== undefined);
  for (const name of ignored) delete env[name];
  return ignored;
}
