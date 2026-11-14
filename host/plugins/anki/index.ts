/**
 * 桌面入口：注入 `node:fs` / `node:zlib` / `node:net` 本地运行时端口（APKG 导入导出、媒体落盘、
 * 模板调试文件、内置模板 JSON 与 AnkiConnect 端口探测）。移动端入口见 `mobile.ts`。
 */
import { createAnkiPlugin } from './src/plugin.ts';
import { nodeAnkiLocalRuntime } from './src/local-runtime.node.ts';

export type { AnkiPluginOptions } from './src/plugin.ts';

export default createAnkiPlugin({ platforms: ['desktop'], localRuntime: () => nodeAnkiLocalRuntime });
