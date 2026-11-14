import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin } from '@/ui-kernel/kernel';
import { contributeCommands } from '@/command-palette/contribute';
import { getChatCommands } from '@/command-palette/modules/chat.commands';
import { createLazyContributionPoint } from '@/ui-sdk/lazy';

/** Lazy contribution point for the chat chunk's blocks, events, modes and toolResults (FE-B2/B3). */
export const chatFeatureContributions = createLazyContributionPoint<(ctx: Context) => void>('chat.feature');

/** Chat V2 commands (FE-B1) + lazy chat feature contributions (FE-B2/B3). */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.chat' },
  apply(ctx) {
    contributeCommands(ctx, getChatCommands);
    ctx.ui.attach(chatFeatureContributions, (mount) => mount(ctx));
  },
}), { order: 120 });
