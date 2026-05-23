import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat v2 conversation control entry contract', () => {
  const chatPageSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'), 'utf-8');
  const inputBarSource = readFileSync(resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarUI.tsx'), 'utf-8');
  const layoutHookSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/useChatPageLayout.tsx'), 'utf-8');
  const sessionSidebarSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/SessionSidebarContent.tsx'), 'utf-8');

  it('moves the desktop conversation-control trigger into the input bar', () => {
    expect(inputBarSource).toContain('renderAdvancedPanel');
    expect(inputBarSource).toContain('SlidersHorizontal');
    expect(inputBarSource).toContain("label={t('common:chat_controls')}");
    expect(inputBarSource).toContain('togglePanel(\'advanced\')');
  });

  it('does not render conversation-control in the ChatV2Page toolbar', () => {
    expect(chatPageSource).not.toContain('chatControlPopoverOpen');
    expect(chatPageSource).not.toContain('<AdvancedPanel');
  });

  it('adds the mobile conversation-control trigger to the chat header actions instead of the session sidebar list', () => {
    expect(layoutHookSource).toContain('SlidersHorizontal');
    expect(layoutHookSource).toContain('setShowChatControl(true);');
    expect(layoutHookSource).toContain('setSessionSheetOpen(true);');
    expect(layoutHookSource).toContain('aria-label={t(\'common:chat_controls\')}');
    expect(sessionSidebarSource).not.toContain('{t(\'common:chat_controls\')}');
    expect(sessionSidebarSource).not.toContain('toggleChatControl');
  });
});
