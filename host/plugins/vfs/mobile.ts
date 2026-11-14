/**
 * 移动端入口：同步本地文件端口由 `host/platform/files/mobile-local-runtime.ts` 提供（内存树 +
 * OPFS 后台水合 + 异步回写），所以上传暂存、导出 ZIP、导图导入等磁盘路径能力可用；
 * 前端工作台 ACR 桥仍不注入。纯 SQLite 的 DSTU 树/搜索/文件夹/笔记/导图指令与桌面一致。
 */
import { mobileLocalRuntime } from '../../platform/files/mobile-local-runtime.ts';
import { createVfsPlugin } from './src/plugin.ts';

export type { VfsPluginOptions } from './src/plugin.ts';

export default createVfsPlugin({ platforms: ['mobile'], localRuntime: ctx => mobileLocalRuntime(ctx).vfs });
