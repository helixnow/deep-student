import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('secondary surface shell migration contract', () => {
  const templateAppSource = readFileSync(resolve(process.cwd(), 'src/features/template-management/TemplateManagementApp.tsx'), 'utf-8');
  const templateBrowserSource = readFileSync(resolve(process.cwd(), 'src/features/template-management/components/TemplateBrowser.tsx'), 'utf-8');
  const templateAppCssSource = readFileSync(resolve(process.cwd(), 'src/features/template-management/template-management.css'), 'utf-8');
  const ankiTasksSource = readFileSync(resolve(process.cwd(), 'src/features/anki-tasks/AnkiTasksApp.tsx'), 'utf-8');
  const ankiTasksCssSource = readFileSync(resolve(process.cwd(), 'src/features/anki-tasks/anki-tasks.css'), 'utf-8');
  const chatPageSource = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'), 'utf-8');
  const skillsPageSource = readFileSync(resolve(process.cwd(), 'src/components/skills-management/SkillsManagementPage.tsx'), 'utf-8');
  const skillsListSource = readFileSync(resolve(process.cwd(), 'src/components/skills-management/SkillsList.tsx'), 'utf-8');
  const notesSidebarSource = readFileSync(resolve(process.cwd(), 'src/features/notes/NotesSidebarV2.tsx'), 'utf-8');

  it('routes template management through workbench-aligned wb-tm surfaces', () => {
    expect(templateAppSource).toContain('wb-tm-root');
    expect(templateAppSource).toContain('wb-tm-nav');
    expect(templateBrowserSource).toContain('wb-tm-card');
    expect(templateAppCssSource).toContain('.wb-tm-card');
    // token 引用 workbench 窗口平铺背景（带兜底），与 flashcards/wb-fc 同源
    expect(templateAppCssSource).toContain('--wb-window-bg');
  });

  it('routes anki tasks through workbench-aligned wb-at surfaces and segmented controls', () => {
    expect(ankiTasksSource).toContain('wb-at-root');
    expect(ankiTasksSource).toContain('wb-at-panel');
    expect(ankiTasksSource).toContain('wb-at-list');
    expect(ankiTasksCssSource).toContain('--wb-window-bg');
    // The shared SegmentedControl primitive applies the
    // `study-shell-segmented` class itself, so consumers may route through
    // the primitive instead of writing the class string inline. Either is
    // acceptable — the visual contract is satisfied in both cases.
    expect(ankiTasksSource).toMatch(/study-shell-segmented|SegmentedControl/);
  });

  it('routes skills and notes secondary surfaces through shared shell classes', () => {
    expect(skillsPageSource).toContain('study-shell-toolbar');
    expect(skillsListSource).toContain('study-shell-secondary-card');
    expect(notesSidebarSource).toContain('study-shell-sidebar-frame');
    expect(notesSidebarSource).toContain('sidebar-shell-item');
  });

  it('renders the chat main pane flush with the desktop header shell', () => {
    expect(chatPageSource).toContain('study-shell-page chat-v2 absolute inset-0 flex overflow-hidden');
    expect(chatPageSource).toContain('renderMainContent()');
    expect(chatPageSource).toContain('study-shell-panel h-full flex flex-col');
    expect(chatPageSource).toContain('study-shell-toolbar flex items-center justify-between');
  });
});
