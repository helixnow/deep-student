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
});
