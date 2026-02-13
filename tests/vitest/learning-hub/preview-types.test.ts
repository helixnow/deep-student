import { describe, expect, it } from 'vitest';

import type { DstuNode, DstuPreviewType } from '@/dstu/types';
import type { ResourceListItem } from '@/components/learning-hub/types';
import {
  dstuNodeToResourceListItem,
  inferFilePreviewTypeFromName,
  nodeTypeToFolderItemType,
} from '@/components/learning-hub/types';

describe('learning hub preview type contracts', () => {
  it('supports audio/video in DSTU and resource preview type unions', () => {
    const dstuAudio: Extract<DstuPreviewType, 'audio'> = 'audio';
    const dstuVideo: Extract<DstuPreviewType, 'video'> = 'video';
    const resourceAudio: Extract<ResourceListItem['previewType'], 'audio'> = 'audio';
    const resourceVideo: Extract<ResourceListItem['previewType'], 'video'> = 'video';

    expect(dstuAudio).toBe('audio');
    expect(dstuVideo).toBe('video');
    expect(resourceAudio).toBe('audio');
    expect(resourceVideo).toBe('video');
  });

  it('infers audio/video preview from file name', () => {
    expect(inferFilePreviewTypeFromName('lecture.mp3')).toBe('audio');
    expect(inferFilePreviewTypeFromName('clip.MP4')).toBe('video');
    expect(inferFilePreviewTypeFromName('slide.pptx')).toBe('pptx');
    expect(inferFilePreviewTypeFromName('unknown.bin')).toBe('none');
  });

  it('maps DSTU node type to folder item type used by Learning Hub', () => {
    expect(nodeTypeToFolderItemType('file')).toBe('file');
    expect(nodeTypeToFolderItemType('mindmap')).toBe('mindmap');
    expect(nodeTypeToFolderItemType('retrieval')).toBeNull();
  });

  it('keeps backward compatibility for legacy card preview type', () => {
    const node = {
      id: 'file_1',
      sourceId: 'file_1',
      path: '/file_1',
      name: 'legacy.pdf',
      type: 'file',
      createdAt: 1,
      updatedAt: 2,
      previewType: 'card',
    } as DstuNode;

    const item = dstuNodeToResourceListItem(node, 'file');
    expect(item.previewType).toBe('exam');
  });
});
