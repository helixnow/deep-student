/**
 * 移动端入口：没有回环监听套接字，浏览器登录以 `CallbackBind` 失败；
 * 状态、设备码登录、注销、用量查询与所有适配器/OCR 服务与桌面一致。
 */
import { createLlmProvidersPlugin } from './src/plugin.ts';

export type { LlmProvidersPluginConfig, LlmProvidersPluginOptions } from './src/plugin.ts';

export default createLlmProvidersPlugin({ platforms: ['mobile'] });
