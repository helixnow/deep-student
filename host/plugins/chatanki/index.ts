/**
 * 桌面入口：注入 `node:fs` 变换脚本文件端口，解释器探测与 job 目录照旧。
 * 移动端入口见 `mobile.ts`。
 */
import { createChatAnkiPlugin } from './src/plugin.ts';
import { nodeTransformFs } from './src/transform-script-fs.node.ts';

export type { ChatAnkiPluginOptions } from './src/plugin.ts';

export default createChatAnkiPlugin({ platforms: ['desktop'], transformFs: () => nodeTransformFs });
