/**
 * 移动端入口：同步本地文件端口由 `host/platform/files/mobile-local-runtime.ts` 提供（内存树 +
 * OPFS 后台水合 + 异步回写），笔记资源落盘、导入导出归档与压缩包解析可用；worker 线程与 ACR
 * 前端委托仍不注入（VACUUM / 标签扫描在调用线程执行，画布走数据面）。
 */
import { mobileLocalRuntime } from '../../platform/files/mobile-local-runtime.ts';
import { createNotesPlugin } from './src/plugin.ts';

export type { NotesPluginOptions } from './src/plugin.ts';

export default createNotesPlugin({ platforms: ['mobile'], localRuntime: ctx => mobileLocalRuntime(ctx).notes });
