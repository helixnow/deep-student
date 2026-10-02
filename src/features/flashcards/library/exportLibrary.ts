/**
 * 卡片库导出 APKG：选中卡导出选中，否则导出整个卡片库。
 * 复用聊天 / 制卡任务台同一条多模板导出链路（每种模板一个 Anki 笔记类型，填空为 Cloze）。
 */
import { listAnkiLibraryCards } from '@/utils/chatApi';
import type { AnkiCard, AnkiLibraryCard } from '@/types';

const PAGE_SIZE = 200;
const MAX_CARDS = 20_000;

async function loadWholeLibrary(): Promise<AnkiLibraryCard[]> {
  const all: AnkiLibraryCard[] = [];
  for (let page = 1; all.length < MAX_CARDS; page += 1) {
    const res = await listAnkiLibraryCards({ page, page_size: PAGE_SIZE });
    const items = (res?.items ?? []) as AnkiLibraryCard[];
    all.push(...items);
    if (items.length < PAGE_SIZE || (typeof res?.total === 'number' && all.length >= res.total)) break;
  }
  return all;
}

function toExportCard(card: AnkiLibraryCard): AnkiCard {
  return {
    ...card,
    is_error_card: false,
    extra_fields: card.extra_fields ?? card.fields ?? {},
    template_id: card.template_id ?? null,
  } as AnkiCard;
}

export type LibraryExportOutcome =
  | { status: 'exported'; count: number; filePath: string; missingMedia: number }
  | { status: 'cancelled' | 'empty' }
  | { status: 'failed' };

export async function exportLibraryApkg(
  selected: AnkiLibraryCard[],
  deckName: string,
): Promise<LibraryExportOutcome> {
  const cards = selected.length > 0 ? selected : await loadWholeLibrary();
  if (cards.length === 0) return { status: 'empty' };
  const { exportCardsAsApkg } = await import('@/features/chat/anki');
  const result = await exportCardsAsApkg({ cards: cards.map(toExportCard), deckName });
  if (result.cancelled) return { status: 'cancelled' };
  if (!result.success || !result.filePath) return { status: 'failed' };
  return {
    status: 'exported',
    count: cards.length - (result.skippedErrorCards ?? 0),
    filePath: result.filePath,
    missingMedia: result.missingMedia?.length ?? 0,
  };
}
