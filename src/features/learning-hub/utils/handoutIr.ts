// ============================================================================
// 讲义 IR 纯 TypeScript 契约、编号与 Markdown 转换工具（零 Node 专属依赖）
// ============================================================================

export type HostHandoutBlock =
  | { type: 'lead' | 'para' | 'h2' | 'note'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; caption?: string; header: string[]; rows: string[][] }
  | { type: 'figure'; ts: number; caption?: string };

export interface SectionRange {
  startSec: number;
  endSec: number;
}

export interface HostHandoutSection {
  heading: string;
  blocks: HostHandoutBlock[];
}

export type HandoutImages = Map<
  number,
  {
    data: Uint8Array;
    width: number;
    height: number;
    caption: string;
    mimeType?: 'image/png' | 'image/jpeg';
  }
>;

export interface HostHandoutDoc {
  title: string;
  courseName: string;
  date: string;
  summary: string;
  sections: HostHandoutSection[];
  images?: HandoutImages;
}

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

export const h1Num = (i: number): string => CN_NUM[i] ?? String(i + 1);
export const h2Num = (i: number): string => `（${h1Num(i)}）`;

export type HandoutDifficulty = 'foundation' | 'intermediate' | 'olympiad';

export type HandoutCalloutKind =
  | 'theorem'
  | 'definition'
  | 'lemma'
  | 'corollary'
  | 'pitfall'
  | 'example';

export interface HandoutCalloutBlock {
  type: 'callout';
  kind: HandoutCalloutKind;
  title: string;
  text: string;
}

export interface HandoutFormulaBlock {
  type: 'formula';
  latex: string;
  label?: string;
  explanation?: string;
}

export interface HandoutDiagramBlock {
  type: 'diagram';
  caption?: string;
  svg: string;
}

export interface HandoutCheckpointBlock {
  type: 'checkpoint';
  id: string;
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
  difficulty?: HandoutDifficulty;
}

export type HandoutExtendedBlock =
  | HostHandoutBlock
  | HandoutCalloutBlock
  | HandoutFormulaBlock
  | HandoutDiagramBlock
  | HandoutCheckpointBlock;

export type HandoutBlock = HandoutExtendedBlock;
export type HandoutContentBlock = HandoutBlock;

export interface HandoutSection {
  id?: string;
  heading: string;
  difficulty?: HandoutDifficulty;
  estimatedMinutes?: number;
  blocks: HandoutBlock[];
}

export interface HandoutDocument extends Omit<HostHandoutDoc, 'sections' | 'courseName' | 'date'> {
  id?: string;
  title: string;
  courseName?: string;
  date?: string;
  summary: string;
  estimatedMinutes?: number;
  difficulty?: HandoutDifficulty;
  sections: HandoutSection[];
}

export interface HandoutSectionAnchorPayload {
  kind: 'handout_section';
  label: string;
  referenceId: string;
  snippet?: string;
}

export const DIFFICULTY_META: Record<
  HandoutDifficulty,
  { label: string; badgeClass: string; dotClass: string }
> = {
  foundation: {
    label: '基础巩固',
    badgeClass: 'bg-success/15 text-success border-border/35',
    dotClass: 'bg-success',
  },
  intermediate: {
    label: '进阶提升',
    badgeClass: 'bg-info/15 text-info border-border/35',
    dotClass: 'bg-info',
  },
  olympiad: {
    label: '竞赛挑战',
    badgeClass: 'bg-warning/15 text-warning border-border/35',
    dotClass: 'bg-warning',
  },
};

export const CALLOUT_KIND_LABELS: Record<HandoutCalloutKind, string> = {
  theorem: '核心定理',
  definition: '基本定义',
  lemma: '引理推导',
  corollary: '重要推论',
  pitfall: '易错警示',
  example: '典型例析',
};

export function validateHandoutIr(doc: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object') {
    return { valid: false, errors: ['讲义文档必须为非空对象'] };
  }
  const candidate = doc as Partial<HandoutDocument>;
  if (typeof candidate.title !== 'string' || !candidate.title.trim()) {
    errors.push('讲义标题不能为空');
  }
  if (!Array.isArray(candidate.sections) || candidate.sections.length === 0) {
    errors.push('讲义必须包含至少一个章节');
  } else {
    candidate.sections.forEach((sec, idx) => {
      if (!sec || typeof sec.heading !== 'string' || !sec.heading.trim()) {
        errors.push(`第 ${idx + 1} 章缺少章节标题`);
      }
      if (!Array.isArray(sec?.blocks) || sec.blocks.length === 0) {
        errors.push(`第 ${idx + 1} 章缺少内容块`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

export function handoutIrToMarkdown(doc: HandoutDocument): string {
  const lines: string[] = [];
  lines.push(`# ${doc.title}`);
  const metaParts: string[] = [];
  if (doc.courseName) metaParts.push(`课程：${doc.courseName}`);
  if (doc.difficulty) metaParts.push(`难度：${DIFFICULTY_META[doc.difficulty].label}`);
  if (doc.estimatedMinutes) metaParts.push(`预计阅读：${doc.estimatedMinutes} 分钟`);
  if (doc.date) metaParts.push(`日期：${doc.date}`);
  if (metaParts.length > 0) {
    lines.push(`> ${metaParts.join(' ｜ ')}`);
  }
  if (doc.summary?.trim()) {
    lines.push('', doc.summary.trim());
  }

  doc.sections.forEach((section, secIndex) => {
    lines.push('', `## ${h1Num(secIndex)}、${section.heading}`);
    let subIndex = 0;
    section.blocks.forEach((block) => {
      switch (block.type) {
        case 'lead':
        case 'para':
          lines.push('', block.text);
          break;
        case 'note':
          lines.push('', `> 注：${block.text}`);
          break;
        case 'h2':
          lines.push('', `### ${h2Num(subIndex++)}${block.text}`);
          break;
        case 'list':
          lines.push(
            '',
            ...block.items.map((item, idx) =>
              block.ordered ? `${idx + 1}. ${item}` : `- ${item}`,
            ),
          );
          break;
        case 'table':
          if (block.caption) {
            lines.push('', `**${block.caption}**`);
          }
          lines.push(
            '',
            `| ${block.header.join(' | ')} |`,
            `| ${block.header.map(() => '---').join(' | ')} |`,
            ...block.rows.map((row) => `| ${row.join(' | ')} |`),
          );
          break;
        case 'figure':
          lines.push('', `![${block.caption ?? '讲义配图'}](figure://${block.ts})`);
          break;
        case 'callout':
          lines.push(
            '',
            `> 【${CALLOUT_KIND_LABELS[block.kind]} · ${block.title}】`,
            `> ${block.text}`,
          );
          break;
        case 'formula':
          lines.push(
            '',
            '$$',
            `${block.latex}${block.label ? ` \\quad (${block.label})` : ''}`,
            '$$',
          );
          if (block.explanation) {
            lines.push(`*推导说明：${block.explanation}*`);
          }
          break;
        case 'diagram':
          lines.push('', `> [图表] ${block.caption ?? '结构示意图'}`);
          break;
        case 'checkpoint':
          lines.push(
            '',
            `#### 随堂自测：${block.question}`,
            ...block.options.map(
              (opt, idx) => `- (${String.fromCharCode(65 + idx)}) ${opt}`,
            ),
          );
          break;
      }
    });
  });

  return lines.join('\n').trim() + '\n';
}
