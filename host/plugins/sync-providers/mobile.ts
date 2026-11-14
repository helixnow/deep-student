/**
 * 移动端入口：没有 `node:net` / `node:tls`（不链接 FTP 传输），也没有可用的本地文件系统。
 * 能力矩阵用 Rust `PlatformStorageCapabilities::android_release`（无 FTP、无 S3 feature）；
 * WebDAV 的内存对象读写与全部命令与桌面一致，走磁盘的落地/续传/增量归档按 `FileSystem` 错误降级。
 */
import { ANDROID_CAPABILITIES } from './src/config.ts';
import type { SyncProvidersPlatform } from './src/entry.ts';
import { createSyncProvidersPlugin } from './src/plugin.ts';

export { childPath } from './src/entry.ts';
export type { SyncProvidersPluginConfig } from './src/entry.ts';

/** Android 发布构建的能力矩阵：不链接 FTP 传输，S3 也不在本构建里。 */
export const MOBILE_PLATFORM: SyncProvidersPlatform = {
  capabilities: ANDROID_CAPABILITIES,
  transports: {},
};

export default createSyncProvidersPlugin({ platforms: ['mobile'], platform: MOBILE_PLATFORM });
