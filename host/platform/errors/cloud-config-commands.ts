/**
 * `cloud_config_ssot_*` / `cloud_config_publish` 命令（`src-tauri/src/cloud_config_commands.rs:10–53`）。
 *
 * 具体 SSOT 持久化与事务化凭据发布由 `ctx.cloudConfig` 提供（L21/L23）；
 * 这里的命令层只做参数转发并保持 Rust 的 `CommandError` 错误通道。
 */
import type { SafeCloudStorageConfig__De, CloudStorageCredentials } from '../../../contracts/ipc/generated/_shared.ts';
import { definePlugin, type Context } from '../../kernel/api.ts';

export function registerCloudConfigCommands(ctx: Context) {
  ctx.commands.register<{ config: SafeCloudStorageConfig__De }>('cloud_config_ssot_save', ({ config }) => ctx.cloudConfig.save(config));
  ctx.commands.register('cloud_config_ssot_get', () => ctx.cloudConfig.get());
  ctx.commands.register('cloud_config_ssot_clear', () => ctx.cloudConfig.clear());
  ctx.commands.register<{
    config: SafeCloudStorageConfig__De;
    credentials: CloudStorageCredentials;
    encryptionPasswordIsPreexisting?: boolean | null;
  }>('cloud_config_publish', ({ config, credentials, encryptionPasswordIsPreexisting }) =>
    ctx.cloudConfig.publish({ config, credentials, encryptionPasswordIsPreexisting }));
}

export default definePlugin({
  meta: {
    id: 'dstu.platform.cloud-config',
    lane: 'F4-security',
    commands: [
      'cloud_config_ssot_save',
      'cloud_config_ssot_get',
      'cloud_config_ssot_clear',
      'cloud_config_publish',
    ],
  },
  inject: ['cloudConfig'],
  apply(ctx) {
    registerCloudConfigCommands(ctx);
  },
});
