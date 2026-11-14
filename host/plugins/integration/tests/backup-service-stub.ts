/**
 * L21 `backup` 服务的集成测试替身（只覆盖 sync-providers 用到的两个方法）。
 *
 * hydrateCloudConfig 只做 cloud_credentials.rs:127 `hydrate_cloud_config` 的凭据一半：
 * 丢弃 IPC 传入的全部秘密，再从 SecureStore（测试提供的凭据）回填——与 L23 在 L21 缺席时的
 * 旧回退路径逐字段一致。SSOT 元数据替换由 L21 自己的测试覆盖。
 */
import type { RuntimeCloudStorageConfig } from '../../sync-providers/api.ts';

export interface StubCredentials {
  webdavPassword?: string | null;
  s3SecretAccessKey?: string | null;
  ftpPassword?: string | null;
  encryptionPassword?: string | null;
}

const nonBlank = (v: string | null | undefined): string | null => (v && v.trim() ? v : null);

export function backupServiceStub(credentials: () => StubCredentials | Promise<StubCredentials>) {
  return {
    tryAcquireOperation(kind: string) {
      const operationId = `test-${kind}`;
      return {
        snapshot: {
          operation_id: operationId,
          kind,
          started_at: new Date().toISOString(),
          process_id: process.pid,
        },
        operationId: () => operationId,
        release: () => undefined,
      };
    },
    async hydrateCloudConfig(config: RuntimeCloudStorageConfig): Promise<void> {
      const c = await credentials();
      if (config.webdav) config.webdav.password = nonBlank(c.webdavPassword) ?? '';
      if (config.s3) config.s3.secretAccessKey = nonBlank(c.s3SecretAccessKey) ?? '';
      if (config.ftp) config.ftp.password = nonBlank(c.ftpPassword) ?? '';
      config.encryptionPassword = nonBlank(c.encryptionPassword) ?? null;
    },
  };
}
