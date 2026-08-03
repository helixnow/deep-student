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
