// Recipe (UI half): slash commands in the chat input.
//
// - `chat.composer.commands` entries show up when the learner types `/` at the start of the input. `name` is the
//   token after the slash (letters, digits, `-`, `_`); `label` / `description` are shown in the list.
// - Choosing a command removes the typed `/name` and calls run(composer): `composer.input` is the rest of the input;
//   `setInput` / `insertText` change the input, `send(text?)` sends it through the normal send path.
// - /quiz needs no Host half: it just sends a prompt. /card asks the Host half and reports the result in a small
//   overlay note (createPluginOverlay), leaving the conversation untouched.
import React from 'react';
import { createPluginOverlay, defineUiPlugin } from '@deepstudent/ui';

function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message.replace(/^[A-Z_]+:\s*/, '') : '没能做成卡片，请稍后再试';
}

function Note({ text, tone }: { text: string; tone: 'info' | 'error' }) {
  return (
    <div role="status" style={{
      position: 'fixed', left: '50%', bottom: 96, transform: 'translateX(-50%)', maxWidth: 420, padding: '10px 16px', borderRadius: 10,
      background: 'hsl(var(--popover))', color: tone === 'error' ? 'hsl(var(--destructive))' : 'hsl(var(--popover-foreground))',
      border: '1px solid hsl(var(--border))', boxShadow: '0 12px 32px -12px hsl(var(--foreground) / 0.3)', fontSize: 14,
    }}>{text}</div>
  );
}

export default defineUiPlugin({
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', host: true },
  apply(ctx) {
    const overlay = createPluginOverlay(ctx);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (text: string, tone: 'info' | 'error' = 'info') => {
      overlay.render(<Note text={text} tone={tone} />);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => overlay.render(null), 3500);
    };

    ctx.ui.contribute('chat.composer.commands', {
      id: '__PLUGIN_ID__/quiz',
      value: {
        name: 'quiz',
        label: '考考我',
        description: '让助手就输入的主题出 3 道题，一题一题问',
        run(composer) {
          const topic = composer.input.trim() || '我们刚才聊的内容';
          composer.send(`请就「${topic}」出 3 道由易到难的题，一次只问一道，等我回答后再判断对错并讲解，然后出下一道。`);
        },
      },
    });

    ctx.ui.contribute('chat.composer.commands', {
      id: '__PLUGIN_ID__/card',
      value: {
        name: 'card',
        label: '做成卡片',
        description: '把输入的知识点做成一张记忆卡片，存进卡片库',
        async run(composer) {
          const text = composer.input.trim();
          if (!text) { show('在 /card 后面写上要记住的内容', 'error'); return; }
          show('正在做卡片…');
          try {
            const card = await ctx.ui.host.__SERVICE__!.makeCard!(text) as { front: string };
            composer.setInput('');
            show(`已做成卡片：${card.front}`);
          } catch (error) {
            show(failureText(error), 'error');
          }
        },
      },
    });
  },
});
