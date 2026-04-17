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

  it('keeps desktop header nav and title cells as explicit hotzones beyond the inner icon buttons', () => {
    expect(appSource).toContain('data-shell-hotzone="desktop-nav"');
    expect(appSource).toContain('data-shell-hotzone="desktop-title"');
    expect(appSource).toContain('const desktopHeaderNavHotzoneLabel = t(\'chatV2:page.newSession\', \'新建会话\')');
    expect(appSource).toContain('const desktopHeaderTitleHotzoneLabel = t(\'common:command_palette_label\', \'命令面板\')');
    expect(appSource).toContain('const handleDesktopTitlebarMouseDown = useCallback((event: React.MouseEvent<HTMLElement>) => {');
    expect(appSource).toContain("const dragExclusionTarget = (event.target as HTMLElement).closest('[data-no-drag]');");
    expect(appSource).toContain('void startDragging(event);');
    expect(appSource).toContain('onMouseDown={handleDesktopTitlebarMouseDown}');
    expect(appSource).toContain('onMouseDown={handleHeaderHotzoneMouseDown}');
    expect(appSource).toContain('onMouseMove={handleHeaderHotzoneMouseMove}');
    expect(appSource).toContain('onMouseUp={handleHeaderHotzoneMouseUp}');
    expect(appSource).toContain('onMouseLeave={handleHeaderHotzoneMouseLeave}');
    expect(appSource).toContain('onClick={(event) => handleHeaderHotzoneClick(event, handleCreateChatSession)}');
    expect(appSource).toContain('onClick={(event) => handleHeaderHotzoneClick(event, openCommandPalette)}');
    expect(appSource).toContain('onKeyDown={(event) => handleHeaderHotzoneKeyDown(event, handleCreateChatSession)}');
    expect(appSource).toContain('onKeyDown={(event) => handleHeaderHotzoneKeyDown(event, openCommandPalette)}');
    expect(appSource).not.toContain('data-tauri-drag-region');
  });
});
