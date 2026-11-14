/**
 * Host 握手 profile 选择（`docs/plugins/FRONTEND.md` §3、`docs/plugins/SDK.md` §6）。
 *
 * - `DS_HOST_PROFILE`（非空）优先；
 * - 否则 `<appDataDir>/plugins/user.profile.json` 存在时用它；
 * - 否则使用官方 profile `host/profiles/desktop.json`（相对 Host 入口所在目录）。
 *
 * 用户 profile 加载失败后的回退与 `host://plugin-profile-failed` 事件由 Host 侧负责；
 * 外壳只保证握手字段指向正确的候选文件。
 */
import { dirname, join, resolve } from 'node:path';

export interface HostProfileOptions {
  safeMode?: boolean;
  /** `DS_HOST_PROFILE`；空字符串按未设置处理。 */
  override?: string | undefined;
  appDataDir: string;
  /** Host 入口文件绝对路径（用于定位同目录树下的官方 profile）。 */
  hostEntry: string;
  /** 文件存在性检查（测试注入）。 */
  exists(path: string): boolean;
}

/** 官方 profile：`<Host 入口目录>/../profiles/desktop.json`。 */
export function officialProfilePath(hostEntry: string): string {
  return resolve(dirname(hostEntry), '..', 'profiles', 'desktop.json');
}

export function resolveHostProfile(options: HostProfileOptions): string {
  // RUST-FIX(RF-W06-safe-mode): 安全模式忽略 DS_HOST_PROFILE 与用户 profile。
  if (options.safeMode) return officialProfilePath(options.hostEntry);
  if (options.override !== undefined && options.override !== '') return resolve(options.override);
  const userProfile = join(options.appDataDir, 'plugins', 'user.profile.json');
  if (options.exists(userProfile)) return userProfile;
  return officialProfilePath(options.hostEntry);
}
