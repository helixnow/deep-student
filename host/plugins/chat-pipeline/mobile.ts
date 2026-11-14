/**
 * 移动端入口：文件访问只经异步 `ctx.files`；发布接口里少数同步形状的调用
 * （产物 sha256 校验、检索页图片解析、主库 settings 探测）没有本地文件系统，
 * 按“不可用”降级：产物校验报告 `check_unavailable`，settings 回退默认值。
 */
import { createChatPipelinePlugin } from './src/plugin.ts';

export type { ChatPipelinePluginOptions } from './src/plugin.ts';

export default createChatPipelinePlugin({ platforms: ['mobile'] });
