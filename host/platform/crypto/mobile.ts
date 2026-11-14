/**
 * 移动端 profile 的 `ctx.crypto` 入口：同一服务 id，提供 Web 实现（WebCrypto + @noble/hashes）。
 * `host/profiles/generate.ts --platform mobile` 优先选用各平台目录下的 `mobile.ts`。
 *
 * 本文件及其运行时依赖（`web.ts` / `encoding.ts` / `api.ts`、kernel 可移植入口 `core.ts`）不得触达 Node 模块。
 */
import { definePlugin } from '../../kernel/core.ts';
import { createWebCrypto } from './web.ts';

export default definePlugin({
  meta: { id: 'dstu.platform.crypto', lane: 'W14-portable', provides: ['crypto'], platforms: ['mobile'] },
  apply(ctx) {
    ctx.reflect.provide('crypto', createWebCrypto());
  },
});
