/**
 * 移动端入口：无 `undici` / 桌面系统代理，使用 Web 标准 `fetch`。
 */
import { createLlmPlugin } from './src/plugin.ts';

export type { LlmPluginOptions } from './src/plugin.ts';

export default createLlmPlugin({ platforms: ['mobile'] });
