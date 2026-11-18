/**
 * 移动端入口：没有 `node:zlib` 压缩与本地 Anki 进程，但有一个 OPFS 支撑的同步本地文件端口
 * （`host/platform/files/mobile-local-runtime.ts`，启动后从 `ctx.files` 水合）。卡片/模板/文档任务等
 * 基于 SQLite 的能力与桌面一致；APKG 导入导出、媒体文件与模板调试文件的文件访问走该端口，
 * ZIP 与 zstd 在本机解码；APKG 的 SQLite 集合通过移动 SQLite 文件池交换。
 */
import { decodeZstd } from '../../platform/native/compression/portable-zstd.ts';
import type { SqliteRuntime } from '../../platform/storage-mobile/sqlite-wasm.ts';
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
  localRuntime: ctx => {
    const files = mobileLocalRuntime(ctx, { readBundledText }).anki;
    const sqlite: SqliteRuntime = ctx.sqliteRuntime;
    return {
      ...files,
      readBundledText,
      collections: {
        read: path => sqlite.exportFile(path),
        write(path, bytes) {
          if (!sqlite.importTemporaryDb) throw new Error('SQLite temporary database import unavailable');
          sqlite.importTemporaryDb(path, bytes);
        },
        remove: path => sqlite.unlink(path),
      },
      async readPickedArchive(path, maxBytes) {
        const meta = await ctx.files.stat(path);
        if (meta.kind !== 'file' || meta.size > maxBytes) throw new Error('Invalid APKG file or archive size');
        return ctx.files.readBytes(path, { maxBytes });
      },
      zstdDecompress: decodeZstd,
    };
  },
});
