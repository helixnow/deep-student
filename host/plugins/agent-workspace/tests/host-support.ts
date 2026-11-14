import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import plugin from '../index.ts';
import { memorySettings } from './support.ts';
import nativePlugin from '../../../platform/native/index.ts';

/**
 * 安装本插件的测试宿主：提供 settings + 真实 F3 storage（复用生产装配路径）。
 * 调用方在 finally 中先 `storage.dispose()`，再 `host.dispose()`。
 */
export async function createWorkspaceHost({ native = process.platform === 'win32', dataDir }: { native?: boolean; dataDir?: string } = {}) {
  const host = await createTestHost({ provide: { settings: memorySettings() }, ...(dataDir === undefined ? {} : { app: { dataDir } }) });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  // 这些 IPC 测试只验证 runtime root 命令；storage 仅需提供 `chat_v2` 句柄给
  // WorkspaceCoordinator，无需执行全库迁移（迁移由应用启动/F3 负责）。
  host.ctx.provide('storage', storage);
  if (native) await host.install(nativePlugin);
  await host.install(plugin);
  return { host, storage };
}
