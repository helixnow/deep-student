import type { ChatAnkiChatBlock, ChatAnkiChatBlockStore } from '../api.ts';

/** In-memory L04 block table double (chronological insertion order). */
export class ChatBlockStoreDouble implements ChatAnkiChatBlockStore {
  private readonly blocks: ChatAnkiChatBlock[] = [];

  seedAnkiCardsBlock(
    id: string, sessionId: string, documentId: string, extra: Record<string, unknown> = {},
    cards: unknown[] = [], deletedCardIds: string[] = [],
  ): ChatAnkiChatBlock {
    return this.addBlock({
      id, sessionId, type: 'anki_cards', status: 'success',
      messageId: `msg-${id}`, blockIndex: 0,
      toolOutput: { documentId, cards, deletedCardIds, ...extra },
    });
  }

  addBlock(block: ChatAnkiChatBlock): ChatAnkiChatBlock {
    this.blocks.push({ ...block, toolOutput: structuredClone(block.toolOutput) });
    return block;
  }

  listSessionBlocks(sessionId: string): ChatAnkiChatBlock[] {
    this.throwListError();
    return this.blocks.filter((block) => block.sessionId === sessionId)
      .map((block) => ({ ...block, toolOutput: structuredClone(block.toolOutput) }));
  }

  getBlock(blockId: string): ChatAnkiChatBlock | null {
    const block = this.blocks.find((candidate) => candidate.id === blockId);
    return block === undefined
      ? null
      : { ...block, toolOutput: structuredClone(block.toolOutput) };
  }

  updateBlock(block: ChatAnkiChatBlock): void {
    this.throwUpdateError();
    const index = this.blocks.findIndex((candidate) => candidate.id === block.id);
    if (index === -1) throw new Error('block_not_found');
    this.blocks[index] = { ...block, toolOutput: structuredClone(block.toolOutput) };
  }

  upsertBlock(block: ChatAnkiChatBlock): void {
    const index = this.blocks.findIndex((candidate) => candidate.id === block.id);
    const stored = { ...block, toolOutput: structuredClone(block.toolOutput) };
    if (index === -1) this.blocks.push(stored);
    else this.blocks[index] = stored;
  }

  deleteBlock(blockId: string): void {
    const index = this.blocks.findIndex((candidate) => candidate.id === blockId);
    if (index === -1) throw new Error('block_not_found');
    this.blocks.splice(index, 1);
  }

  /** Simulates the L04 block table becoming unreadable for the next requery. */
  failNextList(error: string): void {
    this.nextListError = error;
  }

  /** Simulates the final persist write failing after validation succeeded. */
  failNextUpdate(error: string): void {
    this.nextUpdateError = error;
  }

  private nextListError: string | null = null;
  private nextUpdateError: string | null = null;

  private throwListError(): void {
    if (this.nextListError === null) return;
    const error = this.nextListError;
    this.nextListError = null;
    throw new Error(error);
  }

  private throwUpdateError(): void {
    if (this.nextUpdateError === null) return;
    const error = this.nextUpdateError;
    this.nextUpdateError = null;
    throw new Error(error);
  }
}
