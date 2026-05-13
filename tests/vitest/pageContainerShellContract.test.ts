import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('page container shell migration contract', () => {
  const chatSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/ChatV2Page.tsx'), 'utf-8');
  const learningHubPageSource = readFileSync(resolve(process.cwd(), 'src/components/learning-hub/LearningHubPage.tsx'), 'utf-8');
  const learningHubSidebarSource = readFileSync(resolve(process.cwd(), 'src/components/learning-hub/LearningHubSidebar.tsx'), 'utf-8');
  const settingsSource = readFileSync(resolve(process.cwd(), 'src/features/settings/components/Settings.tsx'), 'utf-8');
  const settingsCssSource = readFileSync(resolve(process.cwd(), 'src/features/settings/styles/settings.css'), 'utf-8');
  const settingsSidebarSource = readFileSync(resolve(process.cwd(), 'src/features/settings/components/SettingsSidebar.tsx'), 'utf-8');

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
    expect(settingsSource).toContain('study-shell-pane study-shell-pane--flush-top');
    expect(settingsSource).toContain('study-shell-toolbar study-shell-toolbar--seamless');
    expect(settingsSource).toContain('SETTINGS_TOP_SAFE_DRAG_ZONE_STYLE');
    expect(settingsSource).toContain("borderBottom: 0");
    expect(settingsSource).not.toContain('study-shell-page settings absolute inset-0 flex flex-row overflow-hidden bg-background');
    expect(settingsSource).not.toContain('study-shell-pane flex-1 min-w-0 h-full flex flex-col overflow-hidden max-w-full bg-background relative');
    expect(settingsCssSource).toMatch(/\.settings\s*\{[^}]*background:\s*var\(--shell-workspace-panel\);/);
    expect(settingsCssSource).not.toMatch(/\.settings\s*\{[^}]*background:\s*hsl\(var\(--background\)\);/);
    expect(settingsSidebarSource).toContain('study-shell-sidebar-frame');
  });
});
