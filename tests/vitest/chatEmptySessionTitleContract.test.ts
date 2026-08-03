import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat empty session title contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const layoutSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/pages/useChatPageLayout.tsx'),
    'utf-8',
  );

  it('keeps an empty current-session title empty in the app shell', () => {
    expect(appSource).toContain("return getSessionTitleText(state.title, '');");
    expect(appSource).toContain('return currentChatHeaderTitle;');
    expect(appSource).not.toContain("return currentChatHeaderTitle || t('sidebar:navigation.chat_v2');");
  });

  it('does not use the new-chat label as a chat header fallback', () => {
    expect(layoutSource).toContain('return currentSession?.title?.trim() || undefined;');
    expect(layoutSource).not.toContain("return currentSession?.title || t('page.newChat');");
  });
});
