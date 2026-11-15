/**
 * 移动端入口：通过平台 HTTP 使用 Worker fetch 或原生网络回退。
 */
import { createLlmPlugin } from './src/plugin.ts';

export type { LlmPluginOptions } from './src/plugin.ts';

export default createLlmPlugin({ platforms: ['mobile'] });
