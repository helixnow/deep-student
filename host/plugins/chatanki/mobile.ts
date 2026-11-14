/**
 * 移动端入口：没有同步文件系统与本地解释器，变换脚本以 `interpreter_unavailable`
 * 拒绝；AI 生成卡片、模板、APKG 导入等其余 chatanki 能力与桌面一致。
 */
import { createChatAnkiPlugin } from './src/plugin.ts';

export type { ChatAnkiPluginOptions } from './src/plugin.ts';

export default createChatAnkiPlugin({ platforms: ['mobile'] });
