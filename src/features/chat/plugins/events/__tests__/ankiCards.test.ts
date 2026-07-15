import { describe, expect, it } from "vitest";
import { ankiCardsEventHandler } from "../ankiCards";

function createStore(initialStatus: "running" | "success" | "error", toolOutput: any = {}) {
  const blockId = "blk-test";
  const blocks = new Map<string, any>([
    [
      blockId,
      {
        id: blockId,
        status: initialStatus,
        toolOutput,
      },
    ],
  ]);

  const store: any = {
    sessionId: "sess-1",
    blocks,
    messageMap: new Map(),
    updateBlock(id: string, patch: any) {
      const current = blocks.get(id);
      blocks.set(id, {
        ...current,
        ...patch,
      });
    },
    updateBlockStatus(id: string, status: string) {
      const current = blocks.get(id);
      blocks.set(id, {
        ...current,
        status,
      });
    },
    setBlockError(id: string, error: string) {
      const current = blocks.get(id);
      blocks.set(id, {
        ...current,
        status: "error",
        error,
      });
    },
  };

  return { store, blockId, blocks };
}

describe("ankiCards event handler", () => {
  it("keeps a partial generation successful when the terminal end event arrives", () => {
    const { store, blockId, blocks } = createStore("running", { cards: [] });
    const card = { id: "c1", front: "q1", back: "a1" };

    ankiCardsEventHandler.onChunk(
      store as any,
      blockId,
      JSON.stringify({
        documentId: "doc-partial",
        cards: [card],
        progress: {
          stage: "completed_with_errors",
          cardsGenerated: 1,
          counts: { total: 2, completed: 1, failed: 1, truncated: 0 },
        },
      }),
    );
    ankiCardsEventHandler.onEnd(store as any, blockId, {
      status: "completed_with_errors",
      documentId: "doc-partial",
      cards: [card],
      progress: {
        stage: "completed_with_errors",
        cardsGenerated: 1,
        counts: { total: 2, completed: 1, failed: 1, truncated: 0 },
      },
    });

    const block = blocks.get(blockId);
    expect(block.status).toBe("success");
    expect(block.toolOutput.finalStatus).toBe("completed_with_errors");
    expect(block.toolOutput.progress.stage).toBe("completed_with_errors");
    expect(block.toolOutput.cards).toEqual([card]);
  });

  it("does not downgrade partial generation when a stale error event follows", () => {
    const { store, blockId, blocks } = createStore("running", {
      cards: [],
      syncStatus: "pending",
    });
    const card = { id: "c1", front: "q1", back: "a1" };

    ankiCardsEventHandler.onChunk(
      store as any,
      blockId,
      JSON.stringify({
        cards: [card],
        progress: {
          stage: "completed_with_errors",
          cardsGenerated: 1,
          counts: { total: 2, completed: 1, failed: 1, truncated: 0 },
        },
      }),
    );
    ankiCardsEventHandler.onError(
      store as any,
      blockId,
      "blocks.ankiCards.errors.partialSegmentsFailed",
    );

    const block = blocks.get(blockId);
    expect(block.status).toBe("success");
    expect(block.toolOutput.finalStatus).toBe("completed_with_errors");
    expect(block.toolOutput.finalError).toBe(
      "blocks.ankiCards.errors.partialSegmentsFailed",
    );
    expect(block.toolOutput.progress.stage).toBe("completed_with_errors");
    expect(block.toolOutput.cards).toEqual([card]);
    expect(block.toolOutput.syncStatus).toBe("pending");
    expect(block.toolOutput.syncError).toBeUndefined();
    expect(block.error).toBeUndefined();
  });

  it("marks a complete generation failure as an error", () => {
    const { store, blockId, blocks } = createStore("running", { cards: [] });

    ankiCardsEventHandler.onError(
      store as any,
      blockId,
      "blocks.ankiCards.errors.partialSegmentsFailed",
    );

    const block = blocks.get(blockId);
    expect(block.status).toBe("error");
    expect(block.error).toBe("blocks.ankiCards.errors.partialSegmentsFailed");
    expect(block.toolOutput.finalStatus).toBe("error");
    expect(block.toolOutput.finalError).toBe(
      "blocks.ankiCards.errors.partialSegmentsFailed",
    );
  });

  it("does not downgrade terminal error block on end", () => {
    const { store, blockId, blocks } = createStore("error", {
      cards: [{ id: "c1", front: "q1", back: "a1" }],
      finalStatus: "error",
      finalError: "boom",
    });

    ankiCardsEventHandler.onEnd(store as any, blockId, {
      status: "success",
      cards: [{ id: "c1", front: "q1-new", back: "a1-new" }],
    });

    const block = blocks.get(blockId);
    expect(block.status).toBe("error");
    expect(block.toolOutput.cards).toEqual([{ id: "c1", front: "q1", back: "a1" }]);
  });

  it("ignores chunk updates after block already reached terminal status", () => {
    const { store, blockId, blocks } = createStore("success", {
      cards: [{ id: "c1", front: "q1", back: "a1" }],
      documentId: "doc-1",
    });

    ankiCardsEventHandler.onChunk(
      store as any,
      blockId,
      JSON.stringify([{ id: "c1", front: "q1-overwrite", back: "a1-overwrite" }]),
    );

    const block = blocks.get(blockId);
    expect(block.status).toBe("success");
    expect(block.toolOutput.cards).toEqual([{ id: "c1", front: "q1", back: "a1" }]);
  });

  it("applies explicit card upserts to a terminal block without reopening it", () => {
    const { store, blockId, blocks } = createStore("success", {
      cards: [{ id: "c1", front: "q1", back: "a1" }],
      documentId: "doc-1",
    });

    ankiCardsEventHandler.onChunk(
      store as any,
      blockId,
      JSON.stringify({
        cardMutation: "upsert",
        cards: [{ id: "c1", front: "q1-fixed", back: "a1-fixed" }],
      }),
    );

    const block = blocks.get(blockId);
    expect(block.status).toBe("success");
    expect(block.toolOutput.cards).toEqual([
      { id: "c1", front: "q1-fixed", back: "a1-fixed" },
    ]);
  });

  it("applies explicit card deletions to a terminal block", () => {
    const { store, blockId, blocks } = createStore("success", {
      cards: [
        { id: "c1", front: "q1", back: "a1" },
        { id: "c2", front: "q2", back: "a2" },
      ],
      documentId: "doc-1",
    });

    ankiCardsEventHandler.onChunk(
      store as any,
      blockId,
      JSON.stringify({ cardMutation: "delete", deletedCardIds: ["c1"] }),
    );

    const block = blocks.get(blockId);
    expect(block.status).toBe("success");
    expect(block.toolOutput.cards).toEqual([{ id: "c2", front: "q2", back: "a2" }]);
  });

  it("does not resurrect a deleted card when a stale end event is replayed", () => {
    const { store, blockId, blocks } = createStore("success", {
      cards: [
        { id: "c1", front: "q1", back: "a1" },
        { id: "c2", front: "q2", back: "a2" },
      ],
      documentId: "doc-1",
    });

    ankiCardsEventHandler.onChunk(
      store as any,
      blockId,
      JSON.stringify({ cardMutation: "delete", deletedCardIds: ["c1"] }),
    );
    ankiCardsEventHandler.onEnd(store as any, blockId, {
      status: "completed",
      cards: [
        { id: "c1", front: "stale", back: "stale" },
        { id: "c2", front: "q2", back: "a2" },
      ],
    });

    const block = blocks.get(blockId);
    expect(block.status).toBe("success");
    expect(block.toolOutput.cards).toEqual([{ id: "c2", front: "q2", back: "a2" }]);
    expect(block.toolOutput.deletedCardIds).toEqual(["c1"]);
  });
});
