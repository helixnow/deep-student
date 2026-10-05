import { invoke } from '@tauri-apps/api/core';
import type { ReciteMissCard } from './reciteCards';

export interface SaveReciteMissCardsInput {
  cards: ReciteMissCard[];
  mindmapId: string | null;
  /** 导图标题（中心主题），用作牌组名与来源标题 */
  title: string;
  deckPrefix: string;
  tag: string;
}

/**
 * 存成普通问答卡并直接加入 FSRS 复习；制卡来源记为这张导图，卡片库 / 复习时「查看出处」能回到导图。
 * 返回加入复习的卡片数。
 */
export async function saveReciteMissCards(input: SaveReciteMissCardsInput): Promise<number> {
  if (input.cards.length === 0) return 0;
  const title = input.title.trim();
  const { ankiApiAdapter } = await import('@/services/ankiApiAdapter');
  const options = {
    deck_name: title ? `${input.deckPrefix}::${title}` : input.deckPrefix,
    note_type: 'Basic',
    enable_images: false,
    max_cards_per_source: input.cards.length,
    max_cards_per_mistake: input.cards.length,
    ...(input.mindmapId ? { source_ref: { kind: 'mindmap', id: input.mindmapId, title } } : {}),
  };
  const response = await ankiApiAdapter.saveAnkiCards({
    cards: input.cards.map((card) => ({
      front: card.front,
      back: card.back,
      tags: [input.tag, ...(title ? [title] : [])],
      images: [],
    })),
    options,
  });
  const savedIds = response.savedIds?.length
    ? response.savedIds
    : (response.cardIdMappings ?? []).map((mapping) => mapping.persistedId);
  if (savedIds.length === 0) {
    throw new Error(response.failed?.[0]?.error || 'save_anki_cards returned no cards');
  }
  await invoke('fsrs_enqueue_cards', { ankiCardIds: savedIds });
  return savedIds.length;
}
