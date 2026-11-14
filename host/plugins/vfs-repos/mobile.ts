/**
 * 移动端入口：同步本地文件端口由 `host/platform/files/mobile-local-runtime.ts` 提供（内存树 +
 * OPFS 后台水合 + 异步回写），blob/附件文件读写可用；worker 线程与同步 ZIP 中央目录解析
 * （`node:zlib`）仍按“不可用”降级，数据库侧与桌面一致。
 */
import { mobileLocalRuntime } from '../../platform/files/mobile-local-runtime.ts';
import { createVfsReposPlugin } from './src/plugin.ts';

export type { VfsReposPluginOptions } from './src/plugin.ts';

export default createVfsReposPlugin({ platforms: ['mobile'], localRuntime: ctx => mobileLocalRuntime(ctx).vfsRepos });
