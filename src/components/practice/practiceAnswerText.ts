import type { Question } from '@/api/questionBankApi';
import { decodeUserAnswer } from '@/api/questionBankApi';
import { parseMatchingData, parseOrderingData } from '@/components/question-types/structured';

export function practiceAnswerText(question: Question, raw: string): string {
  const decoded = decodeUserAnswer(question.questionType, raw);
  if (decoded?.type === 'fill_blank') return decoded.blanks.map((text, i) => `${i + 1}. ${text}`).join('\n');
  if (decoded?.type === 'matching') {
    const data = parseMatchingData(question.structured_data);
    return decoded.pairs.map(pair => `${data?.left.find(item => item.key === pair.left)?.content ?? pair.left} → ${data?.right.find(item => item.key === pair.right)?.content ?? pair.right}`).join('\n');
  }
  if (decoded?.type === 'ordering') {
    const data = parseOrderingData(question.structured_data);
    return decoded.order.map((key, i) => `${i + 1}. ${data?.items.find(item => item.key === key)?.content ?? key}`).join('\n');
  }
  return raw;
}
