import { describe, expect, it } from 'vitest';

import type { DstuNode } from '@/dstu/types';
import { mapDstuNodeToLearningHubItem } from '@/chat-v2/pages/openResourceMapping';

const makeNode = (overrides: Partial<DstuNode>): DstuNode => ({
  id: 'file_123',
  sourceId: 'file_123',
  path: '/folder/file_123',
  name: 'resource.bin',
  type: 'file',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

describe('ChatV2 openResource mapping', () => {
  it('maps modern file preview types directly', () => {
    const node = makeNode({ name: 'lesson.mp3', previewType: 'audio' });
    const item = mapDstuNodeToLearningHubItem(node);

    expect(item).not.toBeNull();
    expect(item?.type).toBe('file');
    expect(item?.previewType).toBe('audio');
  });

  it('falls back to filename inference when previewType is none', () => {
    const node = makeNode({ name: 'demo.mp4', previewType: 'none' });
    const item = mapDstuNodeToLearningHubItem(node);

    expect(item?.previewType).toBe('video');
  });

  it('maps mindmap nodes without degrading to none', () => {
    const node = makeNode({
      id: 'mm_1',
      sourceId: 'mm_1',
      path: '/mm_1',
      name: '导图',
      type: 'mindmap',
      previewType: 'mindmap',
    });

    const item = mapDstuNodeToLearningHubItem(node);
    expect(item?.type).toBe('mindmap');
    expect(item?.previewType).toBe('mindmap');
  });

  it('returns null for unsupported node types', () => {
    const node = makeNode({
      id: 'ret_1',
      sourceId: 'ret_1',
      path: '/ret_1',
      name: '检索结果',
      type: 'retrieval',
    });

    expect(mapDstuNodeToLearningHubItem(node)).toBeNull();
  });
});
