import { describe, expect, it } from 'vitest';
import {
  CONTENT_APP_TYPE_IDS,
  FILE_PREVIEW_APP_TYPE_ID,
  NOTES_APP_TYPE_ID,
  RESOURCE_APP_TYPE_IDS,
  resolveWorkbenchAppTypeId,
  resourceTypeToAppTypeId,
} from '../typeMap';

describe('workbench content typeMap', () => {
  it('独立内容窗口不再包含 note', () => {
    expect([...CONTENT_APP_TYPE_IDS]).toEqual([
      'textbook',
      'exam',
      'translation',
      'essay',
      'image',
      'file',
    ]);
  });

  it('八类可开窗资源类型映射到知识工作区、领域应用或统一文件预览器', () => {
    expect(resourceTypeToAppTypeId('note')).toBe(NOTES_APP_TYPE_ID);
    expect(resourceTypeToAppTypeId('textbook')).toBe(FILE_PREVIEW_APP_TYPE_ID);
    expect(resourceTypeToAppTypeId('exam')).toBe('exam');
    expect(resourceTypeToAppTypeId('translation')).toBe('translation');
    expect(resourceTypeToAppTypeId('essay')).toBe('essay');
    expect(resourceTypeToAppTypeId('image')).toBe(FILE_PREVIEW_APP_TYPE_ID);
    expect(resourceTypeToAppTypeId('file')).toBe(FILE_PREVIEW_APP_TYPE_ID);
    expect(resourceTypeToAppTypeId('mindmap')).toBe(NOTES_APP_TYPE_ID);
  });

  it('不可开窗类型返回 null', () => {
    expect(resourceTypeToAppTypeId('all')).toBeNull();
    expect(resourceTypeToAppTypeId('unknown-type')).toBeNull();
    expect(resourceTypeToAppTypeId('__proto__')).toBeNull();
    expect(resourceTypeToAppTypeId('constructor')).toBeNull();
    expect(resourceTypeToAppTypeId('toString')).toBeNull();
    expect(resourceTypeToAppTypeId('')).toBeNull();
  });

  it('RESOURCE_APP_TYPE_IDS 仅含 instanceKey 资源窗口', () => {
    expect(RESOURCE_APP_TYPE_IDS.size).toBe(7);
    for (const typeId of CONTENT_APP_TYPE_IDS) {
      expect(RESOURCE_APP_TYPE_IDS.has(typeId)).toBe(true);
    }
    expect(RESOURCE_APP_TYPE_IDS.has('note')).toBe(false);
    expect(RESOURCE_APP_TYPE_IDS.has(FILE_PREVIEW_APP_TYPE_ID)).toBe(true);
    expect(RESOURCE_APP_TYPE_IDS.has('mindmap')).toBe(false);
    expect(RESOURCE_APP_TYPE_IDS.has('notes')).toBe(false);
    expect(RESOURCE_APP_TYPE_IDS.has('files')).toBe(false);
    expect(RESOURCE_APP_TYPE_IDS.has('chat')).toBe(false);
  });

  it('resolveWorkbenchAppTypeId aliases note/mindmap → notes and passes through others', () => {
    expect(resolveWorkbenchAppTypeId('note')).toBe(NOTES_APP_TYPE_ID);
    expect(resolveWorkbenchAppTypeId('mindmap')).toBe(NOTES_APP_TYPE_ID);
    expect(resolveWorkbenchAppTypeId('notes')).toBe(NOTES_APP_TYPE_ID);
    expect(resolveWorkbenchAppTypeId('exam')).toBe('exam');
    expect(resolveWorkbenchAppTypeId('desktop')).toBe('desktop');
  });
});
