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
  const groupManagementSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/hooks/useGroupManagement.ts'),
    'utf-8'
  );
  const chatPageEventsSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/pages/useChatPageEvents.ts'),
    'utf-8'
  );

  it('uses the current chat session title in the desktop shell header while keeping empty chat draft states quiet', () => {
    expect(appSource).toContain('sessionManager.getCurrentSessionId()');
    expect(appSource).toContain('sessionManager.get(chatHeaderSessionId)');
    expect(appSource).toContain('getChatHeaderTitleFromStoreState(chatHeaderStore?.getState())');
    expect(appSource).toContain('const desktopShellViewLabel = useMemo(() => {');
    expect(appSource).toContain('if (currentView === \'chat-v2\') {');
    expect(appSource).toContain('return currentChatHeaderTitle;');
    expect(appSource).toContain("const [currentChatHeaderTitle, setCurrentChatHeaderTitle] = useState('');");
    expect(appSource).toContain("if (!chatHeaderSessionId) {\n      setCurrentChatHeaderTitle('');");
    expect(appSource).toContain("if (!state) {\n      return '';");
    expect(appSource).toContain('t(\'sidebar:navigation.chat_v2\', \'新会话\')');
  });

  it('subscribes the chat header to current-session changes and active-session title updates', () => {
    expect(appSource).toContain("import { getHiddenDraftSessionScope } from './chat-v2/pages/draftSession';");
    expect(appSource).toContain('const getChatHeaderTitleFromStoreState = useCallback((state?: ChatStore | null) => {');
    expect(appSource).toContain('if (getHiddenDraftSessionScope(state?.sessionMetadata)) {');
    expect(appSource).toContain("return '';");
    expect(sessionTypesSource).toContain("| 'current-session-changed'");
    expect(sessionManagerSource).toContain("type: 'current-session-changed'");
    expect(appSource).toContain('const currentChatHeaderStoreUnsubscribeRef = useRef<(() => void) | null>(null);');
    expect(appSource).toContain('currentChatHeaderStoreUnsubscribeRef.current?.();');
    expect(appSource).toContain('sessionManager.subscribe((event) => {');
    expect(appSource).toContain("event.type === 'current-session-changed'");
    expect(appSource).toContain("event.type === 'session-created'");
    expect(appSource).toContain('syncAndBindCurrentChatHeader(activeSessionId);');
    expect(appSource).toContain('activeChatHeaderStore.subscribe(');
    expect(appSource).toContain('(state, prevState) => {');
    expect(appSource).toContain('state.title !== prevState.title');
    expect(appSource).toContain('state.sessionMetadata !== prevState.sessionMetadata');
  });

  it('renders chat header title through an animated display label when a generated title arrives later', () => {
    expect(appSource).toContain('const DESKTOP_CHAT_TITLE_TYPEWRITER_INTERVAL_MS = 26;');
    expect(appSource).toContain('const [animatedDesktopShellViewLabel, setAnimatedDesktopShellViewLabel] = useState(desktopShellViewLabel);');
    expect(appSource).toContain('const previousDesktopShellViewLabelRef = useRef(desktopShellViewLabel);');
    expect(appSource).toContain("if (currentView !== 'chat-v2' || !desktopShellViewLabel || desktopShellViewLabel === previousLabel) {");
    expect(appSource).toContain('setAnimatedDesktopShellViewLabel(desktopShellViewLabel);');
    expect(appSource).toContain('setAnimatedDesktopShellViewLabel(desktopShellViewLabel.slice(0, nextLength));');
    expect(appSource).toContain('<span className="block truncate">{animatedDesktopShellViewLabel}</span>');
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

  it('toggles maximize/restore when the desktop titlebar receives a primary-button double click', () => {
    const titlebarMouseDownStart = appSource.indexOf('const handleDesktopTitlebarMouseDown = useCallback');
    const titlebarMouseDownEnd = appSource.indexOf('const clearHeaderHotzonePress', titlebarMouseDownStart);
    const handlerSource = appSource.slice(titlebarMouseDownStart, titlebarMouseDownEnd);
    const hotzoneMouseDownStart = appSource.indexOf('const handleHeaderHotzoneMouseDown = useCallback');
    const hotzoneMouseDownEnd = appSource.indexOf('const handleHeaderHotzoneMouseMove', hotzoneMouseDownStart);
    const hotzoneHandlerSource = appSource.slice(hotzoneMouseDownStart, hotzoneMouseDownEnd);

    expect(appSource).toContain("import { getCurrentWindow } from '@tauri-apps/api/window';");
    expect(appSource).toContain('function shouldIgnoreHeaderHotzoneTarget(target: EventTarget | null, boundary?: Element)');
    expect(appSource).toContain('return closestInteractiveTarget !== null && closestInteractiveTarget !== boundary;');
    expect(appSource).toContain('const HEADER_HOTZONE_CLICK_ACTIVATION_DELAY_MS = 180;');
    expect(appSource).toContain('function clearHeaderHotzoneActivationTimer(element: HTMLElement) {');
    expect(appSource).toContain('window.clearTimeout(Number(timerId));');
    expect(appSource).toContain('window.setTimeout(() => {');
    expect(appSource).toContain('const toggleDesktopWindowMaximize = useCallback(async () => {');
    expect(appSource).toContain('const appWindow = getCurrentWindow();');
    expect(appSource).toContain('if (await appWindow.isMaximized()) {');
    expect(appSource).toContain('await appWindow.unmaximize();');
    expect(appSource).toContain('await appWindow.maximize();');
    expect(appSource).not.toContain('toggleMaximize()');
    expect(handlerSource).toContain('if (event.button !== 0) {');
    expect(handlerSource).toContain('shouldIgnoreHeaderHotzoneTarget(event.target, event.currentTarget)');
    expect(handlerSource).toContain('if (event.detail === 2) {');
    expect(handlerSource).toContain('void toggleDesktopWindowMaximize();');
    expect(handlerSource).toContain('return;');
    expect(handlerSource).toContain('void startDragging(event);');
    expect(hotzoneHandlerSource).toContain('if (event.detail === 2) {');
    expect(hotzoneHandlerSource).toContain('event.preventDefault();');
    expect(hotzoneHandlerSource).toContain('clearHeaderHotzoneActivationTimer(event.currentTarget);');
    expect(hotzoneHandlerSource).toContain("event.currentTarget.dataset.shellHotzoneSuppressClick = 'true';");
    expect(hotzoneHandlerSource).toContain('void toggleDesktopWindowMaximize();');
    expect(hotzoneHandlerSource).toContain('shouldIgnoreHeaderHotzoneTarget(event.target, event.currentTarget)');
  });

  it('keeps sidebar toggle clicks immediate while allowing new session icon double-click maximize', () => {
    const accessoryStart = appSource.indexOf('function DesktopSidebarAccessory');
    const accessoryEnd = appSource.indexOf('function DesktopHeaderNavControls', accessoryStart);
    const accessorySource = appSource.slice(accessoryStart, accessoryEnd);

    const navControlsStart = appSource.indexOf('function DesktopHeaderNavControls');
    const navControlsEnd = appSource.indexOf('type CurrentView = NavigationCurrentView;', navControlsStart);
    const navControlsSource = appSource.slice(navControlsStart, navControlsEnd);

    const navControlsUsageStart = appSource.indexOf('<DesktopHeaderNavControls');
    const navControlsUsageEnd = appSource.indexOf('/>', navControlsUsageStart);
    const navControlsUsageSource = appSource.slice(navControlsUsageStart, navControlsUsageEnd);

    expect(appSource).toContain('function handleDesktopToolbarButtonMouseDown(');
    expect(appSource).toContain('function handleDesktopToolbarButtonClick(');
    expect(appSource).toContain('if (event.detail === 2) {');
    expect(appSource).toContain('void onTitlebarDoubleClick();');
    expect(appSource).toContain('if (event.detail > 1) {');
    expect(appSource).toContain('activate();');
    expect(appSource).not.toContain('shellToolbarButtonActivationTimer');

    expect(accessorySource).not.toContain('onTitlebarDoubleClick');
    expect(accessorySource).not.toContain('handleDesktopToolbarButtonMouseDown');
    expect(accessorySource).not.toContain('handleDesktopToolbarButtonClick(event, onToggle)');
    expect(accessorySource).toContain('onClick={onToggle}');
    expect(navControlsSource).toContain('onTitlebarDoubleClick');
    expect(navControlsSource).toContain('onMouseDown={(event) => handleDesktopToolbarButtonMouseDown(event, onTitlebarDoubleClick)}');
    expect(navControlsSource).toContain('onClick={(event) => handleDesktopToolbarButtonClick(event, onNewSession)}');

    expect(navControlsUsageSource).toContain('onTitlebarDoubleClick={toggleDesktopWindowMaximize}');
  });

  it('keeps a visible desktop toolbar button for creating a chat session after the history controls', () => {
    const navControlsStart = appSource.indexOf('function DesktopHeaderNavControls');
    const navControlsEnd = appSource.indexOf('type CurrentView = NavigationCurrentView;');
    expect(navControlsStart).toBeGreaterThanOrEqual(0);
    expect(navControlsEnd).toBeGreaterThan(navControlsStart);

    const navControlsSource = appSource.slice(navControlsStart, navControlsEnd);
    const forwardButtonIndex = navControlsSource.indexOf('aria-label={forwardLabel}');
    const newSessionButtonIndex = navControlsSource.indexOf('aria-label={newSessionLabel}');

    expect(appSource).toContain("import { StudyComposeIcon } from './components/icons/StudySidebarIcons';");
    expect(navControlsSource).toContain('handleDesktopToolbarButtonClick(event, onNewSession)');
    expect(navControlsSource).toContain('<CommonTooltip content={newSessionLabel} position="bottom">');
    expect(navControlsSource).not.toContain('title={newSessionLabel}');
    expect(navControlsSource).toContain('aria-label={newSessionLabel}');
    expect(navControlsSource).toContain('<StudyComposeIcon className="h-4 w-4" />');
    expect(forwardButtonIndex).toBeGreaterThanOrEqual(0);
    expect(newSessionButtonIndex).toBeGreaterThan(forwardButtonIndex);
  });

  it('uses CommonTooltip for desktop shell sidebar and history controls instead of native title', () => {
    const accessoryStart = appSource.indexOf('function DesktopSidebarAccessory');
    const accessoryEnd = appSource.indexOf('function DesktopHeaderNavControls');
    expect(accessoryStart).toBeGreaterThanOrEqual(0);
    expect(accessoryEnd).toBeGreaterThan(accessoryStart);
    const accessorySource = appSource.slice(accessoryStart, accessoryEnd);

    expect(appSource).toContain("const desktopSidebarToggleLabel = t('common:navigation.toggle_sidebar', '切换边栏');");
    expect(accessorySource).toContain('<CommonTooltip content={label} position="bottom">');
    expect(accessorySource).not.toContain('title={label}');

    const navControlsStart = appSource.indexOf('function DesktopHeaderNavControls');
    const navControlsEnd = appSource.indexOf('type CurrentView = NavigationCurrentView;');
    expect(navControlsStart).toBeGreaterThanOrEqual(0);
    expect(navControlsEnd).toBeGreaterThan(navControlsStart);
    const navControlsSource = appSource.slice(navControlsStart, navControlsEnd);

    expect(navControlsSource).toContain('<CommonTooltip content={backTitle} position="bottom">');
    expect(navControlsSource).toContain('<CommonTooltip content={forwardTitle} position="bottom">');
    expect(navControlsSource).not.toContain('title={backTitle}');
    expect(navControlsSource).not.toContain('title={forwardTitle}');
  });

  it('labels desktop new-session affordances with the active chat group name when available', () => {
    expect(appSource).toContain("import { groupCache } from './chat-v2/core/store/groupCache';");
    expect(appSource).toContain("const [currentChatHeaderGroupName, setCurrentChatHeaderGroupName] = useState('');");
    expect(appSource).toContain('const getChatHeaderGroupNameFromStoreState = useCallback((state?: ChatStore | null) => {');
    expect(appSource).toContain("return groupCache.get(state.groupId)?.name ?? '';");
    expect(appSource).toContain('state.groupId !== prevState.groupId');
    expect(appSource).toContain("window.addEventListener('chat-v2:groups-updated', syncCurrentChatHeaderGroupName);");
    expect(appSource).toContain('const desktopHeaderNewSessionTooltipLabel = currentChatHeaderGroupName');
    expect(appSource).toContain("t('chatV2:page.newSessionInGroup', {");
    expect(appSource).toContain('groupName: currentChatHeaderGroupName');
    expect(appSource).toContain("defaultValue: '在 {{groupName}} 中新建会话'");
    expect(appSource).toContain('newSessionLabel={desktopHeaderNewSessionTooltipLabel}');
    expect(appSource).toContain('aria-label={desktopHeaderNewSessionTooltipLabel}');
    expect(groupManagementSource).toContain('setGroupsCache(sorted);\n    emitGroupListUpdated();');
    expect(chatPageEventsSource).toContain('const getCurrentSessionGroupId = useCallback(() => {');
    expect(chatPageEventsSource).toContain('const groupId = getCurrentStore()?.getState().groupId;');
    expect(chatPageEventsSource).toContain('createSession(getCurrentSessionGroupId());');
  });
});
