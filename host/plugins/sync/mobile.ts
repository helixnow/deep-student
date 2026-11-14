/**
 * 移动端入口：同步本地文件端口由 `host/platform/files/mobile-local-runtime.ts` 提供（内存树 +
 * OPFS 后台水合 + 异步回写），快照备份、资产树扫描与导出/导入的文件读写可用；
 * 云服务传输与 SQLite 指令与桌面一致。
 */
import { mobileLocalRuntime } from '../../platform/files/mobile-local-runtime.ts';
import { createSyncPlugin } from './src/plugin.ts';

export type { SyncPluginOptions } from './src/plugin.ts';

export default createSyncPlugin({ platforms: ['mobile'], localRuntime: ctx => mobileLocalRuntime(ctx).sync });
