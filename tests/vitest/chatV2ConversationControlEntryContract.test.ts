import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat v2 conversation control entry contract', () => {
  const chatPageSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/ChatV2Page.tsx'), 'utf-8');
  const layoutHookSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/useChatPageLayout.tsx'), 'utf-8');
  const sessionSidebarSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/SessionSidebarContent.tsx'), 'utf-8');

  it('moves the desktop conversation-control trigger into the chat toolbar as a compact icon popover', () => {
    expect(chatPageSource).toContain('Popover');
    expect(chatPageSource).toContain('PopoverTrigger');
    expect(chatPageSource).toContain('PopoverContent');
    expect(chatPageSource).toContain('chatControlPopoverOpen');
    expect(chatPageSource).toContain('aria-label={t(\'common:chat_controls\')}');
    expect(chatPageSource).toContain('<SlidersHorizontal className="w-4 h-4" />');
    expect(chatPageSource).toContain('<AdvancedPanel');
    expect(chatPageSource).toContain('onClose={() => setChatControlPopoverOpen(false)}');
    expect(chatPageSource).not.toContain('onClick={toggleChatControl}');
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
