/**
 * 桌面入口：注入 `node:fs` / `node:fs/promises` / `node:zlib` 本地运行时端口
 * （CSV 导入导出、便携题库 zip、配图读取、试卷导出落盘）。移动端入口见 `mobile.ts`。
 */
import { createQbankPlugin } from './src/plugin.ts';
import { nodeQbankLocalRuntime } from './src/local-runtime.node.ts';

export type { QbankPluginOptions, QbankPluginService } from './src/plugin.ts';

export default createQbankPlugin({ platforms: ['desktop'], localRuntime: () => nodeQbankLocalRuntime });
