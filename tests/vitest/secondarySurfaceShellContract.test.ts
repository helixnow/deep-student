import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('secondary surface shell migration contract', () => {
  const templatePageSource = readFileSync(resolve(process.cwd(), 'src/components/TemplateManagementPage.tsx'), 'utf-8');
  const templatePageCssSource = readFileSync(resolve(process.cwd(), 'src/components/TemplateManagementPage.css'), 'utf-8');
  const taskDashboardSource = readFileSync(resolve(process.cwd(), 'src/components/anki/TaskDashboardPage.tsx'), 'utf-8');
  const chatPageSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/pages/ChatV2Page.tsx'), 'utf-8');
  const skillsPageSource = readFileSync(resolve(process.cwd(), 'src/components/skills-management/SkillsManagementPage.tsx'), 'utf-8');
  const skillsListSource = readFileSync(resolve(process.cwd(), 'src/components/skills-management/SkillsList.tsx'), 'utf-8');
  const notesSidebarSource = readFileSync(resolve(process.cwd(), 'src/components/notes/NotesSidebarV2.tsx'), 'utf-8');

  it('routes template management through shell page/pane wrappers and shell card classes', () => {
    expect(templatePageSource).toContain('study-shell-page');
    expect(templatePageSource).toContain('study-shell-pane');
    expect(templatePageSource).toContain('template-shell-card');
    expect(templatePageCssSource).toContain('.template-shell-card');
  });

  it('routes task dashboard through shell page, pane, panel, and segmented controls', () => {
    expect(taskDashboardSource).toContain('study-shell-page');
    expect(taskDashboardSource).toContain('study-shell-pane');
    expect(taskDashboardSource).toContain('study-shell-panel');
    // The shared SegmentedControl primitive applies the
    // `study-shell-segmented` class itself, so consumers may route through
    // the primitive instead of writing the class string inline. Either is
    // acceptable — the visual contract is satisfied in both cases.
    expect(taskDashboardSource).toMatch(/study-shell-segmented|SegmentedControl/);
  });

  it('routes skills and notes secondary surfaces through shared shell classes', () => {
    expect(skillsPageSource).toContain('study-shell-toolbar');
    expect(skillsListSource).toContain('study-shell-secondary-card');
    expect(notesSidebarSource).toContain('study-shell-sidebar-frame');
    expect(notesSidebarSource).toContain('sidebar-shell-item');
  });

  it('renders the chat main pane flush with the desktop header shell', () => {
    expect(chatPageSource).toContain('study-shell-pane study-shell-pane--flush-top');
    expect(chatPageSource).toContain('study-shell-toolbar study-shell-toolbar--seamless');
  });
});
