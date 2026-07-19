export type NoteTemplateId = 'lecture' | 'mistake' | 'exam';

export interface NoteTemplate {
  id: NoteTemplateId;
  title: string;
  markdown: string;
}

const ZH_NOTE_TEMPLATES: readonly NoteTemplate[] = [
  {
    id: 'lecture',
    title: '听课笔记',
    markdown: '## 本节目标\n\n- \n\n## 核心概念\n\n\n## 例题与推导\n\n\n## 课后问题\n\n- [ ] ',
  },
  {
    id: 'mistake',
    title: '错题复盘',
    markdown: '## 原题\n\n\n## 我的解法\n\n\n## 错因\n\n- \n\n## 正确思路\n\n\n## 同类提醒\n\n- [ ] ',
  },
  {
    id: 'exam',
    title: '应试整理',
    markdown: '## 考查范围\n\n- \n\n## 高频考点\n\n- \n\n## 易错清单\n\n- [ ] \n\n## 时间分配\n\n\n## 考前速记\n\n',
  },
] as const;

const EN_NOTE_TEMPLATES: readonly NoteTemplate[] = [
  {
    id: 'lecture',
    title: 'Lecture notes',
    markdown: '## Learning goals\n\n- \n\n## Core concepts\n\n\n## Examples and derivations\n\n\n## Follow-up questions\n\n- [ ] ',
  },
  {
    id: 'mistake',
    title: 'Mistake review',
    markdown: '## Original problem\n\n\n## My approach\n\n\n## Root cause\n\n- \n\n## Correct approach\n\n\n## Reminder for similar problems\n\n- [ ] ',
  },
  {
    id: 'exam',
    title: 'Exam review',
    markdown: '## Scope\n\n- \n\n## High-frequency topics\n\n- \n\n## Common mistakes\n\n- [ ] \n\n## Time allocation\n\n\n## Final review\n\n',
  },
] as const;

export function getNoteTemplates(language?: string): readonly NoteTemplate[] {
  return language?.toLowerCase().startsWith('zh') ? ZH_NOTE_TEMPLATES : EN_NOTE_TEMPLATES;
}

export function applyNoteTemplate(currentMarkdown: string, templateMarkdown: string): string {
  const template = templateMarkdown.trim();
  if (!currentMarkdown.trim()) return `${template}\n`;
  const separator = currentMarkdown.endsWith('\n') ? '\n---\n\n' : '\n\n---\n\n';
  return `${currentMarkdown}${separator}${template}\n`;
}
