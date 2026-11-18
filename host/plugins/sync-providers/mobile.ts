/**
 * WebDAV uses the shared OPFS file view and a replayable HTTP body on mobile.
 * This profile exposes WebDAV through the Android storage capability matrix.
 */
import { mobileLocalRuntime } from '../../platform/files/mobile-local-runtime.ts';
import { ANDROID_CAPABILITIES } from './src/config.ts';
import type { SyncProvidersPlatform } from './src/entry.ts';
import { createSyncProvidersPlugin } from './src/plugin.ts';

export { childPath } from './src/entry.ts';
export type { SyncProvidersPluginConfig } from './src/entry.ts';

/** Android 发布构建的能力矩阵：不链接 FTP 传输，S3 也不在本构建里。 */
export const MOBILE_PLATFORM: SyncProvidersPlatform = {
  capabilities: ANDROID_CAPABILITIES,
  transports: {},
  bufferedWebDavUploads: true,
};

export default createSyncProvidersPlugin({ platforms: ['mobile'], platform: MOBILE_PLATFORM, localFs: ctx => mobileLocalRuntime(ctx).providerFiles });
