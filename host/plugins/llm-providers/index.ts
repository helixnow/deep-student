/**
 * 桌面入口：注入 `node:http` 回环回调服务与桌面 SSRF 远端图片下载器，浏览器登录流程可用。
 * 移动端入口见 `mobile.ts`（只支持设备码流程）。
 */
import { fetchBinaryWithCache } from '../../platform/net-policy/node.ts';
import { createLlmProvidersPlugin } from './src/plugin.ts';
import { nodeOAuthCallbackServer } from './src/openai-codex/callback-server.ts';

export type { LlmProvidersPluginConfig, LlmProvidersPluginOptions } from './src/plugin.ts';

export default createLlmProvidersPlugin({
  platforms: ['desktop'],
  capabilities: { callbackServer: nodeOAuthCallbackServer },
  remoteImageDownloader: fetchBinaryWithCache,
});
