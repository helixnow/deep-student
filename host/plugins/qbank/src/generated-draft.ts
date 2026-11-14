import type { GeneratedQuestionDraft } from '../api.ts';

/** Serde shape for historical GeneratedQuestionDraft rows (types.rs:83-126).
 * Invalid rows cause the task repository to discard the entire drafts array, as Rust does.
 */
export function decodeGeneratedDraft(value: unknown): GeneratedQuestionDraft | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.question_type !== 'string' || typeof input.content !== 'string') return null;
  for (const key of ['local_id', 'group_id', 'original_label', 'answer', 'explanation', 'difficulty', 'smiles', 'smiles_caption', 'source_ref']) {
    if (input[key] != null && typeof input[key] !== 'string') return null;
  }
  if (input.tags != null && (!Array.isArray(input.tags) || input.tags.some(tag => typeof tag !== 'string'))) return null;
  if (input.options != null && (!Array.isArray(input.options) || input.options.some(option =>
    typeof option !== 'object' || option === null || typeof option.key !== 'string' || typeof option.content !== 'string'))) return null;
  const optional = (key: string) => typeof input[key] === 'string' ? { [key]: input[key] } : {};
  return {
    ...optional('local_id'), ...optional('group_id'), ...optional('original_label'),
    question_type: input.question_type, content: input.content,
    options: input.options == null ? null : (input.options as { key: string; content: string }[]).map(({ key, content }) => ({ key, content })),
    answer: input.answer as string | null ?? null,
    explanation: input.explanation as string | null ?? null,
    difficulty: input.difficulty as string | null ?? null,
    tags: input.tags as string[] | null ?? null,
    ...(input.structured_data == null ? {} : { structured_data: input.structured_data }),
    smiles: input.smiles as string | null ?? null,
    smiles_caption: input.smiles_caption as string | null ?? null,
    ...optional('source_ref'),
  };
}
