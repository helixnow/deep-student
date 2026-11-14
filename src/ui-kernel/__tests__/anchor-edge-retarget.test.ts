import { describe, expect, it, vi } from 'vitest';
import { addTypedEventListener } from '@/events/registry';
import { AnchorRegistry, DS_ANCHOR_EDGES_CHANGED_EVENT } from '../services/anchors';

describe('anchor edge retarget notifications', () => {
  it('invalidates both old and new resources and aliases so stale tints disappear', async () => {
    const registry = new AnchorRegistry();
    const listener = vi.fn();
    const off = registry.subscribeAnchorEdgesChanged(listener);
    const browser = vi.fn();
    const offBrowser = addTypedEventListener(DS_ANCHOR_EDGES_CHANGED_EVENT, browser);
    const common = { edgeId: 'edge', sourceKind: 'mindmap' as const, sourceResourceId: 'mm', sourceSubId: 'n',
      sourceAnchor: { kind: 'mindmap' as const, resourceId: 'mm', nodeId: 'n' } };
    await registry.upsertAnchorEdges([{ ...common, targetAnchor: { kind: 'pdf', resourceId: 'old', aliasResourceId: 'old-alias', page: 1 } }]);
    listener.mockClear();
    browser.mockClear();
    await registry.upsertAnchorEdges([{ ...common, targetAnchor: { kind: 'pdf', resourceId: 'new', aliasResourceId: 'new-alias', page: 2 } }]);
    expect(listener).toHaveBeenCalledWith({ sourceResourceId: 'mm', targetResourceIds: ['old', 'old-alias', 'new', 'new-alias'] });
    expect(browser.mock.calls[0][0]).toEqual(listener.mock.calls[0][0]);
    expect(await registry.queryAnchorEdgesByTarget({ targetResourceIds: ['old', 'old-alias'] })).toEqual([]);
    off(); offBrowser(); registry.dispose();
  });
});
