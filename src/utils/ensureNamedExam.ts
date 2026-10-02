import { dstu } from '@/dstu/api';
import { createEmpty } from '@/dstu/factory';

/**
 * 找到或新建一个具名题目集（如「速答错题」「作文错题」）：记住的 id → 按名字查找 → 新建。
 * 用于把各处产生的错题汇入题库，从而能练习、进 SM-2 复习、计入掌握度。
 */
export async function ensureNamedExam(name: string, storageKey: string): Promise<string> {
  let remembered: string | null = null;
  try { remembered = localStorage.getItem(storageKey); } catch { /* 无存储时按名字查找 */ }
  if (remembered) {
    const found = await dstu.get(`/${remembered}`);
    if (found.ok && found.value?.type === 'exam') return remembered;
  }
  const listed = await dstu.list('/', { typeFilter: 'exam', search: name, limit: 20 });
  const existing = listed.ok ? listed.value.find((node) => node.type === 'exam' && node.name === name) : undefined;
  const examId = existing?.id ?? await (async () => {
    const created = await createEmpty({ type: 'exam', name });
    if (!created.ok) throw created.error;
    return created.value.id;
  })();
  try { localStorage.setItem(storageKey, examId); } catch { /* 下次按名字查找 */ }
  return examId;
}
