/** Foundation-only deterministic projection identity helpers. Persistence lives in services. */
export type {
  ProjectedFlashcardSourceKind,
  ProjectedFlashcardInput,
  ProjectedFlashcardHostAdapter,
  ProjectedFlashcardCallOptions,
  ProjectedFlashcardUpsertResult,
  ProjectedFlashcardBatchResult,
  ProjectedFlashcardRemoveResult,
  ProjectedSaveCardsParams,
  ProjectedSaveCardsResponse,
} from '@/services/liveCardProjector';
import type { ProjectedFlashcardSourceKind } from '@/services/liveCardProjector';

const encoder = new TextEncoder();
const prefixes: Record<ProjectedFlashcardSourceKind, string> = {
  note_inline: 'card_inline_',
  mindmap_node: 'card_mm_',
  pdf_occlusion: 'card_io_',
  qbank_mistake: 'card_qb_',
};

export function fnv1a64HexFoundation(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(String(input))) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

export function buildProjectedCardId(kind: ProjectedFlashcardSourceKind, sourceId: string): string {
  const id = sourceId.trim();
  if (!id) throw new Error('sourceId is required to build a projected flashcard ID');
  return `${prefixes[kind] ?? 'card_proj_'}${fnv1a64HexFoundation(id)}`;
}
