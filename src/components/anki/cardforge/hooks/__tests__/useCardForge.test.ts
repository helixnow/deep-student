import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCardForge } from "../useCardForge";
import { cardAgent, taskController } from "../../engines";

type Listener = (event: { documentId?: string; payload: any }) => void;

const listeners = new Map<string, Set<Listener>>();

function emitEvent(eventType: string, event: { documentId?: string; payload: any }) {
  const current = listeners.get(eventType);
  if (!current) return;
  for (const listener of current) {
    listener(event);
  }
}

describe("useCardForge", () => {
  beforeEach(() => {
    listeners.clear();
    vi.restoreAllMocks();

    vi.spyOn(cardAgent, "on").mockImplementation((eventType: string, listener: any) => {
      const set = listeners.get(eventType) ?? new Set<Listener>();
      set.add(listener as Listener);
      listeners.set(eventType, set);
      return () => {
        set.delete(listener as Listener);
      };
    });
  });

  it("sets documentId from document:start so pause works before generate resolves", async () => {
    vi.spyOn(cardAgent, "generateCards").mockImplementation(
      () => new Promise(() => undefined),
    );
    const pauseSpy = vi.spyOn(taskController, "pause").mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useCardForge());

    act(() => {
      void result.current.generate({ content: "demo" } as any);
    });

    act(() => {
      emitEvent("document:start", {
        documentId: "doc-early",
        payload: { totalSegments: 2 },
      });
    });

    expect(result.current.documentId).toBe("doc-early");

    await act(async () => {
      const output = await result.current.pause();
      expect(output.ok).toBe(true);
    });

    expect(pauseSpy).toHaveBeenCalledWith("doc-early");
  });

  it("ignores events from other document once active document is established", () => {
    const { result } = renderHook(() => useCardForge());

    act(() => {
      emitEvent("document:start", {
        documentId: "doc-a",
        payload: { totalSegments: 1 },
      });
    });

    act(() => {
      emitEvent("card:generated", {
        documentId: "doc-b",
        payload: {
          card: { id: "c1", front: "q", back: "a", tags: [], images: [] },
        },
      });
    });

    expect(result.current.documentId).toBe("doc-a");
    expect(result.current.cards).toHaveLength(0);
  });

  it("does not bootstrap documentId from non-start events", () => {
    const { result } = renderHook(() => useCardForge());

    act(() => {
      emitEvent("card:generated", {
        documentId: "doc-foreign",
        payload: {
          card: { id: "c1", front: "q", back: "a", tags: [], images: [] },
        },
      });
    });

    expect(result.current.documentId).toBeNull();
    expect(result.current.cards).toHaveLength(0);
  });
});
