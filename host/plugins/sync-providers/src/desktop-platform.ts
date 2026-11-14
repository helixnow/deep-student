/**
 * 桌面平台的传输表：WebDAV / S3 在共享体里，FTP 只能在这里链接（`node:net` / `node:tls`）。
 *
 * 只由桌面入口 `host/plugins/sync-providers/index.ts` 导入；移动端入口（`mobile.ts`）不链接 FTP。
 */
import type { CloudStorage, FtpConfig } from '../api.ts';
import { DESKTOP_CAPABILITIES } from './config.ts';
import type { StorageTransports, SyncProvidersPlatform } from './entry.ts';
import { FtpStorage } from './ftp.ts';

export const DESKTOP_TRANSPORTS: StorageTransports = {
  ftp: (config: FtpConfig, root: string): CloudStorage => new FtpStorage(config, root),
};

export const DESKTOP_PLATFORM: SyncProvidersPlatform = {
  capabilities: DESKTOP_CAPABILITIES,
  transports: DESKTOP_TRANSPORTS,
};
