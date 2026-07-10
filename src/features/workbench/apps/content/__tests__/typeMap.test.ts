import { describe, expect, it } from 'vitest';
import {
  CONTENT_APP_TYPE_IDS,
  MINDMAP_APP_TYPE_ID,
  RESOURCE_APP_TYPE_IDS,
  resourceTypeToAppTypeId,
} from '../typeMap';

describe('workbench content typeMap', () => {
  it('七类内容 typeId 完整', () => {
    expect([...CONTENT_APP_TYPE_IDS]).toEqual([
      'note',
      'textbook',
      'exam',
      'translation',
      'essay',
      'image',
      'file',
    ]);
  });

  it('八类可开窗资源类型逐一映射到对应 typeId', () => {
    expect(resourceTypeToAppTypeId('note')).toBe('note');
    expect(resourceTypeToAppTypeId('textbook')).toBe('textbook');
    expect(resourceTypeToAppTypeId('exam')).toBe('exam');
    expect(resourceTypeToAppTypeId('translation')).toBe('translation');
    expect(resourceTypeToAppTypeId('essay')).toBe('essay');
    expect(resourceTypeToAppTypeId('image')).toBe('image');
    expect(resourceTypeToAppTypeId('file')).toBe('file');
    expect(resourceTypeToAppTypeId('mindmap')).toBe(MINDMAP_APP_TYPE_ID);
  });

  it('不可开窗类型返回 null', () => {
    expect(resourceTypeToAppTypeId('all')).toBeNull();
    expect(resourceTypeToAppTypeId('unknown-type')).toBeNull();
  });

  it('RESOURCE_APP_TYPE_IDS = 七类内容 + mindmap，不含 files/chat', () => {
    expect(RESOURCE_APP_TYPE_IDS.size).toBe(8);
    for (const typeId of CONTENT_APP_TYPE_IDS) {
      expect(RESOURCE_APP_TYPE_IDS.has(typeId)).toBe(true);
    }
    expect(RESOURCE_APP_TYPE_IDS.has('mindmap')).toBe(true);
    expect(RESOURCE_APP_TYPE_IDS.has('files')).toBe(false);
    expect(RESOURCE_APP_TYPE_IDS.has('chat')).toBe(false);
  });
});
