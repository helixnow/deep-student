/**
 * 桌面入口：注入 `undici` + 系统代理 HTTP 客户端。
 * 移动端入口见 `mobile.ts`（使用标准 `fetch` 传输）。
 */
import { createLlmHttpClient } from './src/http_proxy.ts';
import { createLlmPlugin } from './src/plugin.ts';

export type { LlmPluginOptions } from './src/plugin.ts';

export default createLlmPlugin({
  platforms: ['desktop'],
  createHttpClient: () => createLlmHttpClient(),
});
