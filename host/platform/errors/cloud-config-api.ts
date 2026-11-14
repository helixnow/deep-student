/**
 * 云配置 SSOT 服务接口（F4 命令使用，实现在 L21/L23）。
 *
 * Rust 的 4 个 `cloud_config_*` 命令是薄包装：命令体分别调用
 * `dstu-sync::cloud_config_commands::{cloud_config_ssot_save_with_database,
 * cloud_config_ssot_get_with_database, cloud_config_ssot_clear_with_database,
 * cloud_config_publish_with_database}`（`src-tauri/src/cloud_config_commands.rs:10–53`）。
 * 对应实现依赖 SSOT 的 `settings` 持久化与安全存储的事务化 staged 凭据发布，
 * 归 L21/L23；本接口只固定命令层的调用形状与错误通道。
 *
 * 提供方要求：`ctx.reflect.provide('cloudConfig', impl)`，方法失败时抛出
 * kernel `CommandError`（`{code,message,data?,traceId?}`），命令层原样透传。
 */
import type {
  CloudConfigPublishResponse,
  CloudConfigSsotResponse,
} from '../../../contracts/ipc/generated/F4-security.ts';
import type {
  CloudStorageCredentials,
  SafeCloudStorageConfig__De,
} from '../../../contracts/ipc/generated/_shared.ts';

export interface CloudConfigPublishArgs {
  config: SafeCloudStorageConfig__De;
  credentials: CloudStorageCredentials;
  encryptionPasswordIsPreexisting?: boolean | null;
}

export interface CloudConfigService {
  /** `cloud_config_ssot_save_with_database`：校验/规范化并写 SSOT，返回已配置视图。 */
  save(config: SafeCloudStorageConfig__De): Promise<CloudConfigSsotResponse>;
  /** `cloud_config_ssot_get_with_database`：未配置返回 `{configured:false}`，其余错误上抛。 */
  get(): Promise<CloudConfigSsotResponse>;
  /** `cloud_config_ssot_clear_with_database`：事务化删除凭据与 SSOT，返回未配置视图。 */
  clear(): Promise<CloudConfigSsotResponse>;
  /** `cloud_config_publish_with_database`：staged 凭据 + SSOT 两段写，失败回滚。 */
  publish(args: CloudConfigPublishArgs): Promise<CloudConfigPublishResponse>;
}

// 必须引入 Context 才能合并到 cordis 重导出的 Context（而不是新建同名接口）。
import type { Context } from '@deepseek-ai/cordis';
export type { Context };

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** L21/L23：云配置 SSOT 与事务化凭据发布。 */
    cloudConfig: CloudConfigService;
  }
}
