import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('app create navigation contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const createBridgeStart = appSource.indexOf('const handleCreateChatSession = (event: Event) =>');
  const createBridgeEnd = appSource.indexOf('const handleCreateNote', createBridgeStart);
  const createBridgeSource = appSource.slice(createBridgeStart, createBridgeEnd).replace(/\s+/g, ' ');

  it('switches to chat when chat create events fire from outside the active page', () => {
    expect(appSource).toContain("window.addEventListener(COMMAND_EVENTS.CHAT_NEW_SESSION, handleCreateChatSession);");
    expect(appSource).toContain("window.addEventListener('modern-sidebar:group-action', handleCreateChatSession);");
    expect(createBridgeSource).toContain("detail?.action && detail.action !== 'create-session'");
    expect(createBridgeSource).toContain("setCurrentView('chat-v2');");
  });

  it('switches to chat when topic create events fire from outside the active page', () => {
    expect(createBridgeSource).toContain("detail.action !== 'create-group'");
  });

  it('switches to learning hub when note create events fire from outside the active page', () => {
    expect(appSource).toContain("window.addEventListener(COMMAND_EVENTS.NOTES_CREATE_NEW, handleCreateNote);");
    expect(appSource).toContain("setCurrentView('learning-hub');");
  });
});
