/**
 * 移动端 profile 的 `ctx.files` 入口：同一服务 id，OPFS 实现（./opfs.ts），允许根在 `AppInfo.dataDir` 之下。
 * `host/profiles/generate.ts --platform mobile` 优先选用本文件。
 *
 * 本文件及其运行时依赖（`opfs.ts` / `api.ts` / `path.ts`、kernel 可移植入口 `core.ts`）不得触达 Node 模块。
 */
import { definePlugin } from '../../kernel/core.ts';
import { unsupportedOnPlatformMessage } from '../errors/unsupported-on-platform.ts';
import { FileError } from './api.ts';
import { createOpfsFiles, mobileRoots, type OpfsDirectoryHandle } from './opfs.ts';

export default definePlugin({
  meta: { id: 'dstu.platform.files', lane: 'W14-portable', provides: ['files'], platforms: ['mobile'] },
  async apply(ctx) {
    const storage = (globalThis as { navigator?: { storage?: { getDirectory?: () => Promise<unknown> } } }).navigator?.storage;
    if (typeof storage?.getDirectory !== 'function') {
      throw new FileError('UnsupportedOnPlatform', 'scope', ctx.app.dataDir, unsupportedOnPlatformMessage('ctx.files', 'mobile', 'navigator.storage.getDirectory() (OPFS) is missing'));
    }
    const root = (await storage.getDirectory()) as OpfsDirectoryHandle;
    ctx.reflect.provide('files', createOpfsFiles({ root, roots: mobileRoots(ctx.app.dataDir) }));
  },
});
