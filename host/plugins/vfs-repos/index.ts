/**
 * 桌面入口：注入 `node:fs` / `node:worker_threads` 同步运行时端口（blob 与附件文件、zip 清单解析、
 * worker 线程执行）。移动端入口见 `mobile.ts`。
 */
import { createVfsReposPlugin } from './src/plugin.ts';
import { nodeVfsReposLocalRuntime } from './src/local-runtime.node.ts';

export type { VfsReposPluginOptions } from './src/plugin.ts';
export { StudySpaceRepo } from './repository/study-spaces.ts';

export default createVfsReposPlugin({ platforms: ['desktop'], localRuntime: () => nodeVfsReposLocalRuntime });
