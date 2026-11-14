import type { ReviewCard } from '../store/fsrsReviewStore';
import { cardMediaSourceTexts, findLibraryCard, openCardSourceTarget, resolveCardSource } from '../cardSource';

/** 卡片库 LIKE 搜索用的线索：题面首行（多行题面按空白合并会对不上原文）。 */
function lookupHint(card: ReviewCard): string {
  const raw = card.text?.trim() || card.front?.trim() || card.back?.trim() || '';
  return raw.split('\n').find((line) => line.trim())?.trim() ?? '';
}

/**
 * 复习中点「查看出处」：若卡片自身已带 `_source_anchor` 语义锚点则直接跳转；
 * 否则按卡片 id 回查卡片库补齐，再按统一优先级打开。没有任何出处时返回 false，由界面提示。
 */
export async function openReviewCardSource(card: ReviewCard): Promise<boolean> {
  const directAnchor = resolveCardSource({ extraFields: card.extraFields });
  if (directAnchor?.kind === 'anchor') {
    await openCardSourceTarget(directAnchor, 'flashcards-review');
    return true;
  }

  const libraryCard = card.ankiCardId
    ? await findLibraryCard(card.ankiCardId, lookupHint(card)).catch(() => null)
    : null;
  const texts = cardMediaSourceTexts(
    libraryCard ?? { back: card.back, front: card.front, text: card.text, extra_fields: card.extraFields },
  );
  const target = resolveCardSource(
    libraryCard ? { ...libraryCard, extraFields: card.extraFields } : { extraFields: card.extraFields },
    texts,
  );
  if (!target) return false;
  await openCardSourceTarget(target, 'flashcards-review');
  return true;
}
