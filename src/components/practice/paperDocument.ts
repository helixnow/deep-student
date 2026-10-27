import type { GeneratedPaper, Question } from '@/stores/questionBankStore';
import type { QuestionImage } from '@/api/questionBankApi';
import {
  parseMatchingData,
  parseOrderingData,
  parseNumericData,
  parseFillBlankData,
  formatNumericAnswer,
} from '@/components/question-types/structured';

export interface PaperDocumentOptions {
  includeAnswers: boolean;
  includeExplanations: boolean;
}
export type PaperSection =
  | { kind: 'heading'; text: string; level: number; pageBreak?: boolean }
  | { kind: 'markdown'; text: string }
  | { kind: 'image'; image: QuestionImage }
  | { kind: 'space'; lines: number };

export function paperAnswer(question: Question): string {
  const blanks = parseFillBlankData(question.structured_data);
  if (question.question_type === 'fill_blank' && blanks)
    return blanks.blanks.map((blank, index) => `${index + 1}. ${blank.answers.join(' / ')}`).join('\n');
  const matching = parseMatchingData(question.structured_data);
  if (question.question_type === 'matching' && matching)
    return matching.pairs.map((p) => `${p.left} → ${p.right}`).join('; ');
  const ordering = parseOrderingData(question.structured_data);
  if (question.question_type === 'ordering' && ordering) return ordering.correct_order.join(' → ');
  const numeric = parseNumericData(question.structured_data);
  if (question.question_type === 'numeric' && numeric) return formatNumericAnswer(numeric);
  return question.answer ?? '';
}

export function buildPaperSections(
  paper: GeneratedPaper,
  options: PaperDocumentOptions,
  labels: {
    material: string;
    appendix: string;
    answer: string;
    explanation: string;
    questions: string;
  },
): PaperSection[] {
  const sections: PaperSection[] = [{ kind: 'heading', text: paper.title, level: 0 }];
  const materialUses = new Map<string, number[]>();
  paper.questions.forEach((q, i) =>
    q.materials?.forEach((m) => materialUses.set(m.id, [...(materialUses.get(m.id) ?? []), i + 1])),
  );
  const seen = new Set<string>();
  paper.questions.forEach((q, i) => {
    q.materials?.forEach((material) => {
      if (seen.has(material.id)) return;
      seen.add(material.id);
      sections.push({
        kind: 'heading',
        text: `${labels.material} · ${labels.questions} ${(materialUses.get(material.id) ?? []).join(', ')}`,
        level: 2,
      });
      sections.push({ kind: 'markdown', text: material.content });
      (material.images ?? []).forEach((image) =>
        sections.push({ kind: 'image', image: { ...image, role: 'material' } }),
      );
    });
    sections.push(
      { kind: 'heading', text: `${i + 1}.`, level: 1 },
      { kind: 'markdown', text: q.content },
    );
    q.images
      ?.filter((image) => image.role !== 'source')
      .forEach((image) => sections.push({ kind: 'image', image }));
    q.options?.forEach((option) =>
      sections.push({ kind: 'markdown', text: `${option.key}. ${option.content}` }),
    );
    const matching = parseMatchingData(q.structured_data);
    const ordering = parseOrderingData(q.structured_data);
    if (q.question_type === 'matching' && matching) {
      sections.push({
        kind: 'markdown',
        text: `| | |\n|---|---|\n${Array.from({ length: Math.max(matching.left.length, matching.right.length) }, (_, i) => `| ${matching.left[i] ? `${matching.left[i].key}. ${matching.left[i].content.replace(/\|/g, '\\|').replace(/\n/g, '<br>')}` : ''} | ${matching.right[i] ? `${matching.right[i].key}. ${matching.right[i].content.replace(/\|/g, '\\|').replace(/\n/g, '<br>')}` : ''} |`).join('\n')}`,
      });
    }
    if (q.question_type === 'ordering' && ordering)
      ordering.items.forEach((item) =>
        sections.push({ kind: 'markdown', text: `${item.key}. ${item.content}` }),
      );
    sections.push({
      kind: 'space',
      lines: ['essay', 'proof', 'calculation', 'short_answer'].includes(q.question_type) ? 5 : 1,
    });
  });
  if (options.includeAnswers || options.includeExplanations) {
    sections.push({ kind: 'heading', text: labels.appendix, level: 0, pageBreak: true });
    paper.questions.forEach((q, i) => {
      sections.push({ kind: 'heading', text: `${i + 1}.`, level: 1 });
      if (options.includeAnswers)
        sections.push({ kind: 'markdown', text: `**${labels.answer}**\n\n${paperAnswer(q)}` });
      if (options.includeExplanations && q.explanation)
        sections.push({ kind: 'markdown', text: `**${labels.explanation}**\n\n${q.explanation}` });
    });
  }
  return sections;
}

export function sectionsToMarkdown(sections: PaperSection[]): string {
  return sections
    .map((section) =>
      section.kind === 'heading'
        ? `${'#'.repeat(Math.min(section.level + 1, 6))} ${section.text}`
        : section.kind === 'markdown'
          ? section.text
          : section.kind === 'image'
            ? `![${section.image.name}](attachment://${section.image.id})`
            : '\n'.repeat(section.lines),
    )
    .join('\n\n');
}
