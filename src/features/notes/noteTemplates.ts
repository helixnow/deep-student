export type NoteTemplateId =
  | 'lecture'
  | 'mistake'
  | 'exam'
  | 'meeting'
  | 'reading'
  | 'weekly'
  | 'cornell'
  | 'literature';

export interface NoteTemplate {
  id: NoteTemplateId;
  title: string;
  /** 模板卡片上的一句话摘要（内联面板预览用） */
  summary: string;
  markdown: string;
}

/**
 * 模板变量：应用模板时替换 `{{date}}` / `{{time}}` / `{{title}}`。
 * 未提供的变量回退为本地化的当前日期/时间与空标题，
 * 保证应用后不会残留 `{{…}}` 占位符。
 */
export interface NoteTemplateVariables {
  /** 替换 `{{date}}`；缺省为本地化的当天日期 */
  date?: string;
  /** 替换 `{{time}}`；缺省为本地化的当前时间（时:分） */
  time?: string;
  /** 替换 `{{title}}`；缺省为空字符串 */
  title?: string;
  /** 缺省日期/时间渲染所用 BCP-47 locale（如 `zh-CN`） */
  locale?: string;
  /** 时钟来源覆盖（测试用） */
  now?: Date;
}

const ZH_NOTE_TEMPLATES: readonly NoteTemplate[] = [
  {
    id: 'lecture',
    title: '听课笔记',
    summary: '目标、核心概念、例题推导与课后问题',
    markdown: '> {{date}}\n\n## 本节目标\n\n- \n\n## 核心概念\n\n\n## 例题与推导\n\n\n## 课后问题\n\n- [ ] ',
  },
  {
    id: 'mistake',
    title: '错题复盘',
    summary: '原题、错因分析与同类题提醒',
    markdown: '> {{date}}\n\n## 原题\n\n\n## 我的解法\n\n\n## 错因\n\n- \n\n## 正确思路\n\n\n## 同类提醒\n\n- [ ] ',
  },
  {
    id: 'exam',
    title: '应试整理',
    summary: '考查范围、高频考点与考前速记',
    markdown: '> {{date}}\n\n## 考查范围\n\n- \n\n## 高频考点\n\n- \n\n## 易错清单\n\n- [ ] \n\n## 时间分配\n\n\n## 考前速记\n\n',
  },
  {
    id: 'meeting',
    title: '会议记录',
    summary: '参会人、讨论要点、决议与行动项',
    markdown: '# {{title}}\n\n> {{date}} {{time}}\n\n## 参会人\n\n- \n\n## 议程\n\n1. \n\n## 讨论要点\n\n\n## 决议\n\n- \n\n## 行动项\n\n- [ ] ',
  },
  {
    id: 'reading',
    title: '读书笔记',
    summary: '核心观点、精彩摘录与个人思考',
    markdown: '# {{title}}\n\n> {{date}}\n\n## 书籍信息\n\n- 作者：\n- 章节：\n\n## 核心观点\n\n- \n\n## 精彩摘录\n\n> \n\n## 我的思考\n\n\n## 行动启发\n\n- [ ] ',
  },
  {
    id: 'weekly',
    title: '周计划',
    summary: '本周目标、重点任务与周末复盘',
    markdown: '> {{date}}\n\n## 本周目标\n\n- [ ] \n\n## 重点任务\n\n1. \n\n## 每日安排\n\n- 周一：\n- 周二：\n- 周三：\n- 周四：\n- 周五：\n- 周末：\n\n## 周末复盘\n\n',
  },
  {
    id: 'cornell',
    title: '康奈尔笔记',
    summary: '线索、笔记与总结三栏式记录法',
    markdown: '> {{date}}\n\n## 线索（Cues）\n\n- \n\n## 笔记（Notes）\n\n\n## 总结（Summary）\n\n',
  },
  {
    id: 'literature',
    title: '文献笔记',
    summary: '文献信息、研究问题、方法与结论',
    markdown: '# {{title}}\n\n> {{date}}\n\n## 文献信息\n\n- 标题：\n- 作者：\n- 来源 / DOI：\n- 年份：\n\n## 研究问题\n\n\n## 方法\n\n\n## 关键结论\n\n- \n\n## 局限与疑问\n\n- \n\n## 与我的研究关联\n\n',
  },
] as const;

const EN_NOTE_TEMPLATES: readonly NoteTemplate[] = [
  {
    id: 'lecture',
    title: 'Lecture notes',
    summary: 'Goals, core concepts, derivations, follow-ups',
    markdown: '> {{date}}\n\n## Learning goals\n\n- \n\n## Core concepts\n\n\n## Examples and derivations\n\n\n## Follow-up questions\n\n- [ ] ',
  },
  {
    id: 'mistake',
    title: 'Mistake review',
    summary: 'Original problem, root cause, reminders',
    markdown: '> {{date}}\n\n## Original problem\n\n\n## My approach\n\n\n## Root cause\n\n- \n\n## Correct approach\n\n\n## Reminder for similar problems\n\n- [ ] ',
  },
  {
    id: 'exam',
    title: 'Exam review',
    summary: 'Scope, high-frequency topics, final review',
    markdown: '> {{date}}\n\n## Scope\n\n- \n\n## High-frequency topics\n\n- \n\n## Common mistakes\n\n- [ ] \n\n## Time allocation\n\n\n## Final review\n\n',
  },
  {
    id: 'meeting',
    title: 'Meeting notes',
    summary: 'Attendees, discussion, decisions, actions',
    markdown: '# {{title}}\n\n> {{date}} {{time}}\n\n## Attendees\n\n- \n\n## Agenda\n\n1. \n\n## Discussion\n\n\n## Decisions\n\n- \n\n## Action items\n\n- [ ] ',
  },
  {
    id: 'reading',
    title: 'Reading notes',
    summary: 'Key ideas, highlights, personal thoughts',
    markdown: '# {{title}}\n\n> {{date}}\n\n## Book info\n\n- Author: \n- Chapter: \n\n## Key ideas\n\n- \n\n## Highlights\n\n> \n\n## My thoughts\n\n\n## Takeaways\n\n- [ ] ',
  },
  {
    id: 'weekly',
    title: 'Weekly plan',
    summary: 'Weekly goals, focus tasks, retrospective',
    markdown: '> {{date}}\n\n## Goals this week\n\n- [ ] \n\n## Focus tasks\n\n1. \n\n## Daily schedule\n\n- Mon: \n- Tue: \n- Wed: \n- Thu: \n- Fri: \n- Weekend: \n\n## Retrospective\n\n',
  },
  {
    id: 'cornell',
    title: 'Cornell notes',
    summary: 'Cues, notes and summary layout',
    markdown: '> {{date}}\n\n## Cues\n\n- \n\n## Notes\n\n\n## Summary\n\n',
  },
  {
    id: 'literature',
    title: 'Literature notes',
    summary: 'Source info, question, method, findings',
    markdown: '# {{title}}\n\n> {{date}}\n\n## Source\n\n- Title: \n- Authors: \n- Venue / DOI: \n- Year: \n\n## Research question\n\n\n## Method\n\n\n## Key findings\n\n- \n\n## Limitations and questions\n\n- \n\n## Relevance to my work\n\n',
  },
] as const;

export function getNoteTemplates(language?: string): readonly NoteTemplate[] {
  return language?.toLowerCase().startsWith('zh') ? ZH_NOTE_TEMPLATES : EN_NOTE_TEMPLATES;
}

function formatDefaultDate(locale: string | undefined, now: Date): string {
  try {
    return now.toLocaleDateString(locale || undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return now.toLocaleDateString();
  }
}

function formatDefaultTime(locale: string | undefined, now: Date): string {
  try {
    return now.toLocaleTimeString(locale || undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return now.toLocaleTimeString();
  }
}

/** 只替换模板正文中的已知变量；用户已有笔记内容不做任何替换。 */
export function renderNoteTemplate(
  templateMarkdown: string,
  variables: NoteTemplateVariables = {},
): string {
  const now = variables.now ?? new Date();
  const values: Record<'date' | 'time' | 'title', string> = {
    date: variables.date ?? formatDefaultDate(variables.locale, now),
    time: variables.time ?? formatDefaultTime(variables.locale, now),
    title: variables.title ?? '',
  };
  return templateMarkdown.replace(
    /\{\{\s*(date|time|title)\s*\}\}/g,
    (_match, key: 'date' | 'time' | 'title') => values[key],
  );
}

export function applyNoteTemplate(
  currentMarkdown: string,
  templateMarkdown: string,
  variables?: NoteTemplateVariables,
): string {
  const template = renderNoteTemplate(templateMarkdown, variables).trim();
  if (!currentMarkdown.trim()) return `${template}\n`;
  const separator = currentMarkdown.endsWith('\n') ? '\n---\n\n' : '\n\n---\n\n';
  return `${currentMarkdown}${separator}${template}\n`;
}
