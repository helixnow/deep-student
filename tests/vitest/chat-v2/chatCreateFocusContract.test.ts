import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat create focus contract', () => {
  const sessionLifecycleSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/pages/useSessionLifecycle.ts'),
    'utf-8'
  );
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );

  it('requests chat input focus after creating or switching to the draft session', () => {
    expect(sessionLifecycleSource).toContain("window.dispatchEvent(new CustomEvent('CHAT_V2_FOCUS_INPUT', {");
    expect(sessionLifecycleSource).toContain('detail: { sessionId },');
    expect(sessionLifecycleSource).toContain('requestChatInputFocus(session.id);');
  });

  it('focuses the active session textarea when the focus event arrives', () => {
    expect(inputBarSource).toContain("window.addEventListener('CHAT_V2_FOCUS_INPUT', handleFocusInput);");
    expect(inputBarSource).toContain("if (detail?.sessionId && detail.sessionId !== sessionId) {");
    expect(inputBarSource).toContain('textarea.focus({ preventScroll: true });');
  });
});
