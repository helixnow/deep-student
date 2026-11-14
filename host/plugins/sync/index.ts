/**
 * 桌面入口：注入 `node:fs` / `node:fs/promises` / `node:os` 本地运行时端口（业务库快照与 WAL、
 * blobs/assets 资产树、导出/导入 JSON、加密对象与断点临时文件）。移动端入口见 `mobile.ts`。
 */
import { createSyncPlugin } from './src/plugin.ts';
import { nodeLocalRuntime } from './src/local-runtime.node.ts';

export type { SyncPluginOptions } from './src/plugin.ts';

export default createSyncPlugin({ platforms: ['desktop'], localRuntime: () => nodeLocalRuntime });
