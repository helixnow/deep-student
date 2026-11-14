/**
 * `src-tauri/tests/cloud_half_configured_credentials_tests.rs` 的逐条移植。
 *
 * 生产链路：所有云同步/连接命令先经 `secure_store::hydrate_cloud_config` 从安全存储
 * 补全凭据，再调 `create_storage`；安全存储没有对应凭据时 secret 字段被补成空串。
 * 本文件锁定这种半配置状态必须 fail-closed，且发生在任何网络 I/O 之前。
 *
 * 生产入口（L23 已发布）：
 * - `validateConfig`：`host/plugins/sync-providers/api.ts` 的公开导出；
 * - `createStorage`：真实插件 provide 的 `ctx.syncProvider.createStorage`（不是测试替身）。
 */
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import { createBackupCrypto } from '../../secrets/backup-crypto.ts';
import type { SecretsService } from '../../secrets/api.ts';
import type { BackupService } from '../../../plugins/backup/api.ts';
import {
  validateConfig,
  type RuntimeCloudStorageConfig,
} from '../../../plugins/sync-providers/api.ts';
import syncProvidersPlugin from '../../../plugins/sync-providers/index.ts';

/** 模拟 hydrate 后的半配置 WebDAV config：endpoint/username 来自持久化配置，password 为空串。 */
function halfConfiguredWebdav(endpoint: string): RuntimeCloudStorageConfig {
  return {
    provider: 'webdav',
    webdav: { endpoint, username: 'student', password: '' },
    root: 'deep-student-sync',
  };
}

let host: TestHost | null = null;

/** 安装真实 L23 插件；`paths` 用 F4 生产实现，`backup` 只提供本测试用到的 hydrate 入口。 */
async function createSyncHost(): Promise<TestHost> {
  const created = await createTestHost();
  created.ctx.provide('paths', createPaths({
    dataDir: created.app.dataDir,
    platform: created.app.platform,
    env: { HOME: created.app.dataDir },
    log: () => undefined,
  }));
  created.ctx.provide('secrets', { backup: createBackupCrypto() } as unknown as SecretsService);
  created.ctx.provide('backup', {
    async hydrateCloudConfig(): Promise<void> {
      // Rust 生产链路此处从 SecureStore 补全 secret；半配置用例故意保持空凭据。
    },
  } as unknown as BackupService);
  await created.install(syncProvidersPlugin);
  host = created;
  return created;
}

afterEach(async () => {
  await host?.dispose();
  host = null;
});

/** 起一个来者不拒的假远端，只用于计数：证明 fail-closed 发生在网络 I/O 之前。 */
async function spawnConnectionCounter(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server: Server = createServer(socket => {
    count += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('counter listener has no port');
  return {
    port: address.port,
    connections: () => count,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

describe('tests/cloud_half_configured_credentials_tests.rs', () => {
  it('webdav_missing_password_fails_closed_before_any_network_io', async () => {
    const counter = await spawnConnectionCounter();
    try {
      const created = await createSyncHost();
      const config = halfConfiguredWebdav(`http://127.0.0.1:${counter.port}/`);

      // 1) 配置校验必须失败，且错误信息可操作（指向密码缺失）。
      const message = (() => {
        try {
          validateConfig(config);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        throw new Error('空密码的 WebDAV 配置必须校验失败');
      })();
      expect(message).toContain('密码');

      // 2) create_storage 是所有连接检查/同步命令的公共入口，必须同样失败。
      await expect(created.ctx.syncProvider.createStorage(config)).rejects.toBeDefined();

      // 3) fail-closed 必须发生在任何网络 I/O 之前。
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(counter.connections()).toBe(0);
    } finally {
      await counter.close();
    }
  });

  it('webdav_whitespace_password_is_still_missing_credential', async () => {
    const created = await createSyncHost();
    const config = halfConfiguredWebdav('https://dav.example.test/dav/');
    config.webdav!.password = '   ';
    expect(() => validateConfig(config)).toThrow();
    await expect(created.ctx.syncProvider.createStorage(config)).rejects.toBeDefined();
  });

  it('s3_missing_secret_key_fails_closed', async () => {
    const created = await createSyncHost();
    const config: RuntimeCloudStorageConfig = {
      provider: 's3',
      s3: {
        endpoint: 'https://s3.example.test',
        bucket: 'coursework',
        accessKeyId: 'public-id',
        // hydration 未找到凭据 → secret 为空
        secretAccessKey: '',
        region: 'us-east-1',
        pathStyle: false,
      },
    };
    const message = (() => {
      try {
        validateConfig(config);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('空 Secret Access Key 的 S3 配置必须校验失败');
    })();
    expect(message).toContain('Secret Access Key');
    await expect(created.ctx.syncProvider.createStorage(config)).rejects.toBeDefined();
  });

  // Rust: #[cfg(not(target_os = "android"))]
  it.skipIf(process.platform === 'android')('ftp_missing_password_fails_closed', async () => {
    const created = await createSyncHost();
    const config: RuntimeCloudStorageConfig = {
      provider: 'ftp',
      ftp: {
        host: 'ftp.example.test',
        port: 21,
        username: 'student',
        password: '',
        useTls: true,
      },
    };
    const message = (() => {
      try {
        validateConfig(config);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('空密码的 FTP 配置必须校验失败');
    })();
    expect(message).toContain('密码');
    await expect(created.ctx.syncProvider.createStorage(config)).rejects.toBeDefined();
  });

  it('webdav_with_full_credentials_passes_validation', async () => {
    const created = await createSyncHost();
    const config = halfConfiguredWebdav('http://127.0.0.1:9/');
    config.webdav!.password = 'correct-horse';
    expect(() => validateConfig(config)).not.toThrow();
    // create_storage 只构建客户端不发请求，应成功。
    await expect(created.ctx.syncProvider.createStorage(config)).resolves.toBeDefined();
  });
});
