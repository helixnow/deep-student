import { describe, expect, it } from 'vitest';
import {
  createFolderNode,
  createFolderOptions,
  createNoteOptions,
  createResourceNode,
  createdEvent,
  DstuListOptions,
  dstuNodeTypeFromString,
  dstuNodeTypeToPathSegment,
  movedEvent,
  type DstuNodeType,
} from '../src/dstu-types.ts';

describe('dstu/types.rs', () => {
  it('test_node_type_serialization', () => {
    for (const type of ['folder', 'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file'] as const) {
      expect(JSON.stringify(type)).toBe(`"${type}"`);
    }
  });

  it('test_node_type_deserialization', () => {
    for (const type of ['folder', 'note', 'textbook'] as const) {
      expect(dstuNodeTypeFromString(JSON.parse(`"${type}"`))).toBe(type);
    }
  });

  it('test_node_type_from_str', () => {
    expect(dstuNodeTypeFromString('note')).toBe('note');
    expect(dstuNodeTypeFromString('notes')).toBe('note');
    expect(dstuNodeTypeFromString('textbook')).toBe('textbook');
    expect(dstuNodeTypeFromString('textbooks')).toBe('textbook');
    expect(dstuNodeTypeFromString('unknown')).toBeUndefined();
    expect(dstuNodeTypeFromString('笔记')).toBe('note');
    expect(dstuNodeTypeFromString('附件')).toBe('image');
  });

  it('test_node_type_to_path_segment', () => {
    expect(dstuNodeTypeToPathSegment('note')).toBe('notes');
    expect(dstuNodeTypeToPathSegment('textbook')).toBe('textbooks');
    expect(dstuNodeTypeToPathSegment('folder')).toBe('folders');
  });

  it('test_dstu_node_serialization_camel_case', () => {
    const json = JSON.stringify(createFolderNode('folder_1', '/高考复习', '高考复习'));
    expect(json).toContain('"type"');
    expect(json).not.toContain('"nodeType"');
    expect(json).toContain('"createdAt"');
    expect(json).toContain('"updatedAt"');
    expect(json).not.toContain('"created_at"');
    expect(json).not.toContain('"updated_at"');
  });

  it('test_dstu_node_skip_none', () => {
    const json = JSON.stringify(createFolderNode('folder_1', '/高考复习', '高考复习'));
    expect(json).not.toContain('"children"');
    expect(json).not.toContain('"childCount"');
    expect(json).not.toContain('"resourceId"');
    expect(json).not.toContain('"size"');
  });

  it('test_dstu_node_resource', () => {
    const node = createResourceNode('note_123', '/高考复习/函数/note_123', '期末复习', 'note', 'res_abc123');
    expect(node.type).toBe('note');
    expect(node.resourceId).toBe('res_abc123');
    expect(node.previewType).toBe('markdown');
  });

  it('test_list_options_defaults', () => {
    const options = DstuListOptions.new();
    expect(options.getLimit()).toBe(50);
    expect(options.getOffset()).toBe(0);
    expect(options.isRecursive()).toBe(false);
    expect(options.isAscending()).toBe(true);
  });

  it('test_list_options_builder', () => {
    const options = DstuListOptions.new()
      .withRecursive(true)
      .withTypes(['note', 'essay'])
      .withSearch('期末')
      .withSort('updatedAt', 'desc')
      .paginate(20, 10);
    expect(options.isRecursive()).toBe(true);
    expect(options.types).toHaveLength(2);
    expect(options.search).toBe('期末');
    expect(options.getLimit()).toBe(20);
    expect(options.getOffset()).toBe(10);
    expect(options.isAscending()).toBe(false);
  });

  it('test_create_options_note', () => {
    const options = createNoteOptions('期末复习笔记', '# 期末复习\n\n...');
    expect(options.type).toBe('note');
    expect(options.name).toBe('期末复习笔记');
    expect(options.content).toBe('# 期末复习\n\n...');
    expect(createFolderOptions('文件夹').type).toBe('folder' satisfies DstuNodeType);
  });

  it('test_watch_event_serialization', () => {
    const node = createFolderNode('folder_1', '/高考复习', '高考复习');
    const json = JSON.stringify(createdEvent('/高考复习', node));
    expect(json).toContain('"type":"created"');
    expect(json).toContain('"path":"/高考复习"');
    expect(json).toContain('"node"');
  });

  it('test_watch_event_moved', () => {
    const node = createResourceNode('note_123', '/物理复习/note_123', '物理笔记', 'note', 'res_123');
    const event = movedEvent('/数学复习/note_123', '/物理复习/note_123', node);
    expect(event.type).toBe('moved');
    expect(event.oldPath).toBe('/数学复习/note_123');
    expect(event.path).toBe('/物理复习/note_123');
  });
});
