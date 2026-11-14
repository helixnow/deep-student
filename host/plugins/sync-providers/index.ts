/**
 * L23-sync-providers: cloud storage transports + cloud sync commands — desktop entry.
 *
 * Rust: `crates/dstu-sync/src/cloud_storage/mod.rs` (14 commands) and
 * `sync_manager.rs` (version/manifest/E2EE policy).
 *
 * The plugin body lives in `src/plugin.ts`; this entry declares the desktop platform: both
 * native transports (config.rs:24) plus the desktop-only FTP backend, which is linked here and
 * nowhere else (`DESKTOP_ONLY_PROVIDERS`), and injects the `node:fs/promises` local file port.
 * The mobile entry is `mobile.ts`.
 *
 * Cross-lane dependencies:
 * - F4 `ctx.secrets.backup` (DSBK encryption, password verifier, encrypted-root memory);
 * - L21 `ctx.backup.hydrateCloudConfig` (SSOT metadata replacement + SecureStore credentials);
 * - L21 `ctx.backup.tryAcquireOperation` (shared `BackupOperationGuard`) acquired before
 *   any storage/manager work and explicitly released on success, error and cancellation.
 */

import type { CloudStorage } from './api.ts';
import { nodeAesGcm } from './src/aes-gcm.node.ts';
import { DESKTOP_PLATFORM } from './src/desktop-platform.ts';
import { nodeLocalFs } from './src/local-fs.node.ts';
import { createStorageFactory, createSyncProvidersPlugin } from './src/plugin.ts';

export { childPath } from './src/entry.ts';
export type { SyncProvidersPluginConfig } from './src/entry.ts';
export { DESKTOP_PLATFORM };

const factory = createStorageFactory(DESKTOP_PLATFORM);

export const createStorage = factory.createStorage;
export const providerService = factory.providerService;
export const createStorageWithCapabilities = factory.createStorage;

export default createSyncProvidersPlugin({
  platforms: ['desktop'],
  platform: DESKTOP_PLATFORM,
  localFs: () => nodeLocalFs,
  aesGcm: () => nodeAesGcm,
});

export type { CloudStorage };
