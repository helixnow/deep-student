import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('page container shell migration contract', () => {
  const chatSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/ChatV2Page.tsx'), 'utf-8');
  const learningHubPageSource = readFileSync(resolve(process.cwd(), 'src/components/learning-hub/LearningHubPage.tsx'), 'utf-8');
  const learningHubSidebarSource = readFileSync(resolve(process.cwd(), 'src/components/learning-hub/LearningHubSidebar.tsx'), 'utf-8');
  const settingsSource = readFileSync(resolve(process.cwd(), 'src/components/Settings.tsx'), 'utf-8');
  const settingsSidebarSource = readFileSync(resolve(process.cwd(), 'src/components/settings/SettingsSidebar.tsx'), 'utf-8');

  it('applies the shared shell frame to chat-v2 containers before deep content blocks', () => {
    expect(chatSource).toContain('study-shell-page');
    expect(chatSource).toContain('study-shell-pane');
    expect(chatSource).toContain('study-shell-panel');
  });

  it('applies the shared shell frame to learning hub page and resource sidebar containers', () => {
    expect(learningHubPageSource).toContain('study-shell-page');
    expect(learningHubPageSource).toContain('study-shell-pane');
    expect(learningHubSidebarSource).toContain('study-shell-sidebar-frame');
  });

  it('applies the shared shell frame to settings shell and preference sidebar containers', () => {
    expect(settingsSource).toContain('study-shell-page');
    expect(settingsSource).toContain('study-shell-pane');
    expect(settingsSidebarSource).toContain('study-shell-sidebar-frame');
  });
});
