export interface ClozeDeletion {
  index: number;
  answer: string;
  hint: string | null;
}

const CLOZE_PATTERN = /\{\{c([1-9]\d*)::([\s\S]*?)\}\}/g;

function splitClozeBody(body: string): { answer: string; hint: string | null } {
  const hintIndex = body.lastIndexOf('::');
  if (hintIndex < 0) {
    return { answer: body, hint: null };
  }
  const hint = body.slice(hintIndex + 2);
  return {
    answer: body.slice(0, hintIndex),
    hint: hint.length > 0 ? hint : null,
  };
}

export function parseClozeDeletions(text: string): ClozeDeletion[] {
  const deletions: ClozeDeletion[] = [];
  for (const match of text.matchAll(CLOZE_PATTERN)) {
    const { answer, hint } = splitClozeBody(match[2]);
    if (!answer.trim()) continue;
    deletions.push({
      index: Number(match[1]),
      answer,
      hint,
    });
  }
  return deletions;
}

export function renderClozeText(text: string, revealed: boolean): string {
  return text.replace(CLOZE_PATTERN, (match, _index: string, body: string) => {
    const { answer, hint } = splitClozeBody(body);
    if (!answer.trim()) return match;
    if (revealed) return answer;
    return hint ? `[${hint}]` : '[...]';
  });
}

export function hasValidCloze(text: string | null | undefined): boolean {
  return typeof text === 'string' && parseClozeDeletions(text).length > 0;
}

/** 计算文本中下一个未使用的挖空编号（默认 1，已有 c1..cN 则返回 max + 1）。 */
export function nextClozeIndex(text: string): number {
  const deletions = parseClozeDeletions(text);
  if (deletions.length === 0) return 1;
  return Math.max(...deletions.map((deletion) => deletion.index)) + 1;
}

/**
 * 在文本指定选区（或末尾）插入 `{{cN::...}}` 挖空标记，
 * 返回新文本及建议的光标选区范围（无选区时选中占位文本便于直接输入）。
 */
export function insertClozeDeletion(
  value: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined,
  placeholder = '...',
): { nextValue: string; nextSelectionStart: number; nextSelectionEnd: number } {
  const safeStart = typeof selectionStart === 'number' && selectionStart >= 0
    ? Math.min(selectionStart, value.length)
    : value.length;
  const safeEnd = typeof selectionEnd === 'number' && selectionEnd >= safeStart
    ? Math.min(selectionEnd, value.length)
    : safeStart;
  const index = nextClozeIndex(value);
  const selected = value.slice(safeStart, safeEnd);
  const inner = selected || placeholder;
  const prefix = `{{c${index}::`;
  const wrapped = `${prefix}${inner}}}`;
  const nextValue = value.slice(0, safeStart) + wrapped + value.slice(safeEnd);
  if (selected) {
    const cursor = safeStart + wrapped.length;
    return { nextValue, nextSelectionStart: cursor, nextSelectionEnd: cursor };
  }
  return {
    nextValue,
    nextSelectionStart: safeStart + prefix.length,
    nextSelectionEnd: safeStart + prefix.length + inner.length,
  };
}
