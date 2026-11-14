/**
 * 移动端入口：没有 `node:zlib` 压缩与本地 Anki 进程，但有一个 OPFS 支撑的同步本地文件端口
 * （`host/platform/files/mobile-local-runtime.ts`，启动后从 `ctx.files` 水合）。卡片/模板/文档任务等
 * 基于 SQLite 的能力与桌面一致；APKG 导入导出、媒体文件与模板调试文件的文件访问走该端口，
 * raw deflate / inflate / zstd 与 AnkiConnect 端口探测仍按“不可用”降级。
 */
import builtinTemplatesData from './data/builtin-templates.json' with { type: 'json' };
import { mobileLocalRuntime } from '../../platform/files/mobile-local-runtime.ts';
import { createAnkiPlugin } from './src/plugin.ts';

export type { AnkiPluginOptions } from './src/plugin.ts';

/** `template-service` / `plugin-runtime` 只读取这一个插件自带数据文件。 */
const readBundledText = (name: string): string => {
  if (name === 'builtin-templates.json') return JSON.stringify(builtinTemplatesData);
  throw new Error(`local filesystem unavailable: read bundled ${name}`);
};

export default createAnkiPlugin({
  platforms: ['mobile'],
  localRuntime: ctx => mobileLocalRuntime(ctx, { readBundledText }).anki,
});
