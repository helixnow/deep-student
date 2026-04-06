import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('app chat header title contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const sessionManagerSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/core/session/sessionManager.ts'),
    'utf-8'
  );
  const sessionTypesSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/core/session/types.ts'),
    'utf-8'
  );

  it('uses the current chat session title in the desktop shell header while keeping a fixed chat shell label elsewhere', () => {
    expect(appSource).toContain('sessionManager.getCurrentSessionId()');
    expect(appSource).toContain('sessionManager.get(chatHeaderSessionId)');
    expect(appSource).toContain('getSessionTitleText(currentChatSessionTitle, t(\'chatV2:page.untitled\', \'未命名会话\'))');
    expect(appSource).toContain('const desktopShellViewLabel = useMemo(() => {');
    expect(appSource).toContain('if (currentView === \'chat-v2\') {');
    expect(appSource).toContain('return currentChatHeaderTitle;');
    expect(appSource).toContain('t(\'sidebar:navigation.chat_v2\', \'智能会话\')');
  });

  it('subscribes the chat header to current-session changes and active-session title updates', () => {
    expect(sessionTypesSource).toContain("| 'current-session-changed'");
    expect(sessionManagerSource).toContain("type: 'current-session-changed'");
    expect(appSource).toContain('const currentChatHeaderStoreUnsubscribeRef = useRef<(() => void) | null>(null);');
    expect(appSource).toContain('currentChatHeaderStoreUnsubscribeRef.current?.();');
    expect(appSource).toContain('sessionManager.subscribe((event) => {');
    expect(appSource).toContain("event.type === 'current-session-changed'");
    expect(appSource).toContain('activeChatHeaderStore.subscribe(');
    expect(appSource).toContain('(state, prevState) => {');
    expect(appSource).toContain('if (state.title !== prevState.title) {');
  });
});
