/**
 * 移动端入口：同步本地文件端口由 `host/platform/files/mobile-local-runtime.ts` 提供（内存树 +
 * OPFS 后台水合 + 异步回写），CSV 导入导出、试卷导出与配图读取可用；便携题库打包需要的
 * raw deflate（`node:zlib`）仍按“不可用”降级。
 */
import { mobileLocalRuntime } from '../../platform/files/mobile-local-runtime.ts';
import { createQbankPlugin } from './src/plugin.ts';

export type { QbankPluginOptions, QbankPluginService } from './src/plugin.ts';

export default createQbankPlugin({ platforms: ['mobile'], localRuntime: ctx => mobileLocalRuntime(ctx).qbank });
