import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin } from '@/ui-kernel/kernel';
import { contributeCommands } from '@/command-palette/contribute';
import { getChatCommands } from '@/command-palette/modules/chat.commands';
import { createLazyContributionPoint } from '@/ui-sdk/lazy';

/** Lazy contribution point for the chat chunk's blocks, events, modes and toolResults (FE-B2/B3). */
export const chatFeatureContributions = createLazyContributionPoint<(ctx: Context) => void>('chat.feature');

/** Chat V2 commands (FE-B1) + lazy chat feature contributions (FE-B2/B3) + composer command / message action slots. */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.chat' },
  apply(ctx) {
    ctx.ui.declareSlot({ name: 'chat.composer.commands', cardinality: 'list', description: '聊天输入框斜杠命令：输入 / 时与技能命令一起列出，选中后 run(ctx) 可读写输入框并发送' });
    ctx.ui.declareSlot({ name: 'chat.message.actions', cardinality: 'list', description: '聊天消息「更多」菜单项：roles 选 user / assistant，run 收到消息 id、角色、Markdown 内容、会话 id' });
    contributeCommands(ctx, getChatCommands);
    ctx.ui.attach(chatFeatureContributions, (mount) => mount(ctx));
  },
}), { order: 120 });
