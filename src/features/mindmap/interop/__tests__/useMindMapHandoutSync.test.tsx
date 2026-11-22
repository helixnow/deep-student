import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { requestHandoutSyncToMindmap } from '@/ui-kernel/services/handoutSyncBridge';
import { compileMindMapSubtreeToHandoutMarkdown } from '@/ui-kernel/services/mindmapHandoutBridge';
import { createMindMapStore, MindMapStoreContext } from '../../store';
import { useMindMapHandoutSync } from '../../hooks/useMindMapHandoutSync';
import type { MindMapDocument } from '../../types';

function makeDoc(rootId: string, title: string, childId: string, childText: string): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: rootId,
      text: title,
      children: [{ id: childId, text: childText, children: [] }],
    },
    meta: { createdAt: '2026-01-01T00:00:00Z' },
  };
}

function SyncHost({ mindmapId, isLoading = false }: { mindmapId: string; isLoading?: boolean }) {
  useMindMapHandoutSync({ mindmapId, isLoading });
  return null;
}

describe('useMindMapHandoutSync — multi-mindmap concurrency', () => {
  it('does not hijack sync requests intended for another open mindmap window', async () => {
    const storeA = createMindMapStore();
    const storeB = createMindMapStore();
    const saveB = vi.fn().mockResolvedValue(true);

    storeA.setState({
      mindmapId: 'mm_A',
      document: makeDoc('root_a', '导图 A', 'a1', '章节 A1'),
    });
    storeB.setState({
      mindmapId: 'mm_B',
      document: makeDoc('root_b', '导图 B', 'b1', '章节 B1'),
      save: saveB,
    });

    const { unmount } = render(
      <>
        {/* Map A 挂载在 Map B 之前：旧逻辑会抢先回 mindmap-not-open 截断 Map B */}
        <MindMapStoreContext.Provider value={storeA}>
          <SyncHost mindmapId="mm_A" />
        </MindMapStoreContext.Provider>
        <MindMapStoreContext.Provider value={storeB}>
          <SyncHost mindmapId="mm_B" />
        </MindMapStoreContext.Provider>
      </>,
    );

    const markdown = compileMindMapSubtreeToHandoutMarkdown(storeB.getState().document.root, {
      mindmapId: 'mm_B',
      mindmapTitle: '导图 B',
      baseHeadingLevel: 1,
      maxHeadingLevel: 4,
      includeMindMapNodeBacklinks: true,
    }).replace('章节 B1', '章节 B1（已修订）');

    const summary = await requestHandoutSyncToMindmap(
      { noteId: 'note_b', noteTitle: '导图 B 讲义', mindmapId: 'mm_B', markdown },
      500,
    );

    expect(summary).toEqual({ ok: true, updated: 1, added: 0 });
    expect(storeB.getState().document.root.children[0].text).toBe('章节 B1（已修订）');
    expect(storeA.getState().document.root.children[0].text).toBe('章节 A1');
    expect(saveB).toHaveBeenCalledWith({ source: 'manual' });

    // 请求指向未打开的导图 mm_C：两个已打开窗口都不抢答，超时返回 timeout
    const missingSummary = await requestHandoutSyncToMindmap(
      { noteId: 'note_c', mindmapId: 'mm_C', markdown },
      40,
    );
    expect(missingSummary).toEqual({ ok: false, updated: 0, added: 0, reason: 'timeout' });

    unmount();
  });
});
