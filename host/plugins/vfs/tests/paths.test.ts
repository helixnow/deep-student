import { describe, expect, it } from 'vitest';
import { buildRealPath, buildSimpleResourcePath, extractFolderPath, extractResourceId, getParentPath, getPathName,
  getResourceTypeFromId, isParentPath, isValidPath, isValidResourceId, isVirtualPathType, normalizePath,
  parseRealPath, ParsedPath } from '../src/paths.ts';
import { DstuFailure } from '../src/dstu-error.ts';

describe('dstu/error.rs', () => {
  it('test_error_display', () => {
    expect(String(new DstuFailure('InvalidPath', '/invalid/path'))).toBe('Invalid DSTU path: /invalid/path');
    expect(String(new DstuFailure('NotFound', '/数学/notes/note_123'))).toBe('Resource not found: /数学/notes/note_123');
    expect(String(new DstuFailure('InvalidNodeType', 'unknown'))).toBe('Invalid node type: unknown');
  });
  it('test_error_to_string_conversion', () => expect(String(new DstuFailure('InvalidPath', 'test'))).toBe('Invalid DSTU path: test'));
});
describe('dstu/path_parser.rs', () => {
  it('test_normalize_path', () => {
    for (const [input, output] of [['', '/'], ['/', '/'], ['/数学', '/数学'], ['/数学/', '/数学'], ['数学', '/数学'], ['  /数学/  ', '/数学']] as const) expect(normalizePath(input)).toBe(output);
  });
  it('test_is_parent_path', () => {
    for (const [parent, child] of [['/', '/数学'], ['/', '/数学/notes'], ['/数学', '/数学/notes'], ['/数学', '/数学/notes/note_123'], ['/数学/notes', '/数学/notes/note_123']] as const) expect(isParentPath(parent, child)).toBe(true);
    for (const [parent, child] of [['/', '/'], ['/数学', '/数学'], ['/数学/notes', '/数学'], ['/物理', '/数学/notes']] as const) expect(isParentPath(parent, child)).toBe(false);
  });
  it('test_get_parent_path', () => {
    expect(getParentPath('/')).toBeNull();
    expect(getParentPath('/数学')).toBe('/');
    expect(getParentPath('/数学/notes')).toBe('/数学');
    expect(getParentPath('/数学/notes/note_123')).toBe('/数学/notes');
  });
  it('test_get_path_name', () => {
    for (const [input, output] of [['/', '/'], ['/数学', '数学'], ['/数学/notes', 'notes'], ['/数学/notes/note_123', 'note_123']] as const) expect(getPathName(input)).toBe(output);
  });
  it('test_build_simple_resource_path_func', () => {
    expect(buildSimpleResourcePath('note_123')).toBe('/note_123');
    expect(buildSimpleResourcePath('tr_123')).toBe('/tr_123');
  });
  it('test_simple_path_format', () => {
    const id = 'note_abc123';
    expect(buildSimpleResourcePath(id)).toBe('/note_abc123');
  });
  it('test_build_simple_resource_path', () => {
    expect(buildSimpleResourcePath('note_123')).toBe('/note_123');
    expect(buildSimpleResourcePath('tr_456')).toBe('/tr_456');
  });
  it('test_parse_real_path_root', () => {
    const p = parseRealPath('/');
    expect(p.isRoot).toBe(true); expect(p.isVirtual).toBe(false); expect(p.fullPath).toBe('/');
    expect(p.folderPath).toBeUndefined(); expect(p.resourceId).toBeUndefined();
  });
  it('test_parse_real_path_empty', () => expect(parseRealPath('').isRoot).toBe(true));
  it('test_parse_real_path_single_folder', () => {
    const p = parseRealPath('/高考复习');
    expect(p.isRoot).toBe(false); expect(p.isVirtual).toBe(false); expect(p.fullPath).toBe('/高考复习');
    expect(p.folderPath).toBe('/高考复习'); expect(p.resourceId).toBeUndefined();
  });
  it('test_parse_real_path_multi_folder', () => {
    const p = parseRealPath('/高考复习/函数/导数');
    expect(p.isRoot).toBe(false); expect(p.fullPath).toBe('/高考复习/函数/导数');
    expect(p.folderPath).toBe('/高考复习/函数/导数'); expect(p.resourceId).toBeUndefined();
  });
  it('test_parse_real_path_resource_at_root', () => {
    const p = parseRealPath('/note_abc123');
    expect(p.isRoot).toBe(false); expect(p.folderPath).toBeUndefined(); expect(p.resourceId).toBe('note_abc123'); expect(p.resourceType).toBe('note');
  });
  it('test_parse_real_path_resource_in_folder', () => {
    const p = parseRealPath('/高考复习/函数/note_abc123');
    expect(p.isRoot).toBe(false); expect(p.fullPath).toBe('/高考复习/函数/note_abc123');
    expect(p.folderPath).toBe('/高考复习/函数'); expect(p.resourceId).toBe('note_abc123'); expect(p.resourceType).toBe('note');
  });
  it('test_parse_real_path_all_resource_types', () => {
    for (const [id, type] of [['note_abc', 'note'], ['tb_xyz', 'textbook'], ['exam_001', 'exam'], ['tr_123', 'translation'], ['essay_456', 'essay'], ['fld_folder1', 'folder'], ['att_file1', 'attachment']] as const) {
      const p = parseRealPath(`/测试文件夹/${id}`); expect(p.resourceId).toBe(id); expect(p.resourceType).toBe(type);
    }
  });
  it('test_parse_real_path_virtual_trash', () => {
    const p = parseRealPath('/@trash'); expect(p.isVirtual).toBe(true); expect(p.isRoot).toBe(false);
    expect(p.fullPath).toBe('/@trash'); expect(p.virtualType).toBe('trash');
  });
  it('test_parse_real_path_virtual_recent', () => { const p = parseRealPath('/@recent'); expect(p.isVirtual).toBe(true); expect(p.virtualType).toBe('recent'); });
  it('test_parse_real_path_virtual_favorites', () => { const p = parseRealPath('/@favorites'); expect(p.isVirtual).toBe(true); expect(p.virtualType).toBe('favorites'); });
  it('test_parse_real_path_legacy_format', () => { const p = parseRealPath('/数学/notes/note_123'); expect(p.isRoot).toBe(false); expect(p.isVirtual).toBe(false); });
  it('test_parse_real_path_legacy_type_list', () => { const p = parseRealPath('/数学/notes'); expect(p.isRoot).toBe(false); expect(p.isVirtual).toBe(false); });
  it('test_parse_real_path_legacy_global', () => { const p = parseRealPath('/_global/translations/tr_123'); expect(p.isRoot).toBe(false); expect(p.isVirtual).toBe(false); });
  it('test_build_real_path_with_folder', () => expect(buildRealPath('/高考复习/函数', 'note_abc123')).toBe('/高考复习/函数/note_abc123'));
  it('test_build_real_path_at_root', () => expect(buildRealPath(null, 'note_abc123')).toBe('/note_abc123'));
  it('test_build_real_path_empty_folder', () => expect(buildRealPath('', 'note_abc123')).toBe('/note_abc123'));
  it('test_build_real_path_root_folder', () => expect(buildRealPath('/', 'note_abc123')).toBe('/note_abc123'));
  it('test_build_real_path_without_leading_slash', () => expect(buildRealPath('高考复习/函数', 'note_abc123')).toBe('/高考复习/函数/note_abc123'));
  it('test_build_real_path_with_trailing_slash', () => expect(buildRealPath('/高考复习/函数/', 'note_abc123')).toBe('/高考复习/函数/note_abc123'));
  it('test_is_valid_path_root', () => expect(isValidPath('/')).toBe(true));
  it('test_is_valid_path_normal', () => { for (const p of ['/高考复习', '/高考复习/函数', '/高考复习/函数/note_abc']) expect(isValidPath(p)).toBe(true); });
  it('test_is_valid_path_empty', () => expect(isValidPath('')).toBe(false));
  it('test_is_valid_path_no_leading_slash', () => expect(isValidPath('高考复习')).toBe(false));
  it('test_is_valid_path_trailing_slash', () => expect(isValidPath('/高考复习/')).toBe(false));
  it('test_is_valid_path_double_slash', () => expect(isValidPath('/高考复习//函数')).toBe(false));
  it('test_is_valid_path_traversal_attack', () => {
    for (const p of ['/..', '/.', '/高考复习/..', '/高考复习/../秘密文件', '/高考复习/./函数', '/../etc/passwd', '/高考复习/.']) expect(isValidPath(p)).toBe(false);
  });
  it('test_extract_resource_id', () => {
    expect(extractResourceId('/高考复习/note_abc')).toBe('note_abc'); expect(extractResourceId('/note_abc')).toBe('note_abc');
    expect(extractResourceId('/高考复习')).toBeNull(); expect(extractResourceId('/')).toBeNull();
  });
  it('test_extract_folder_path', () => {
    expect(extractFolderPath('/高考复习/函数/note_abc')).toBe('/高考复习/函数'); expect(extractFolderPath('/note_abc')).toBeNull();
    expect(extractFolderPath('/高考复习/函数')).toBe('/高考复习/函数'); expect(extractFolderPath('/')).toBeNull();
  });
  it('test_get_resource_type_all_prefixes', () => {
    for (const [id, type] of [['note_abc', 'note'], ['tb_xyz', 'textbook'], ['exam_001', 'exam'], ['tr_123', 'translation'], ['essay_456', 'essay'], ['fld_folder', 'folder'], ['att_file', 'attachment'], ['img_pic', 'image'], ['file_doc', 'file']] as const) expect(getResourceTypeFromId(id)).toBe(type);
  });
  it('test_get_resource_type_invalid', () => { for (const id of ['abc123', 'unknown_id', '数学']) expect(getResourceTypeFromId(id)).toBeNull(); });
  it('test_is_valid_resource_id_true', () => { for (const id of ['note_abc', 'tb_123', 'exam_001']) expect(isValidResourceId(id)).toBe(true); });
  it('test_is_valid_resource_id_false', () => { for (const id of ['abc', '数学', 'notes']) expect(isValidResourceId(id)).toBe(false); });
  it('test_parse_real_path_resource_id_length_limit', () => {
    const valid = `note_${'a'.repeat(123)}`; expect(parseRealPath(`/${valid}`).resourceId).toBe(valid);
    expect(() => parseRealPath(`/note_${'a'.repeat(124)}`)).toThrow('资源ID长度超限');
  });
});
describe('dstu/path_types.rs', () => {
  it('test_parsed_path_root', () => {
    const p = ParsedPath.root(); expect(p.isRoot).toBe(true); expect(p.isVirtual).toBe(false); expect(p.fullPath).toBe('/'); expect(p.folderPath).toBeUndefined(); expect(p.resourceId).toBeUndefined();
  });
  it('test_parsed_path_virtual', () => {
    const p = ParsedPath.virtualPath('trash'); expect(p.isVirtual).toBe(true); expect(p.isRoot).toBe(false); expect(p.fullPath).toBe('/@trash'); expect(p.virtualType).toBe('trash');
  });
  it('test_parsed_path_folder', () => {
    const p = ParsedPath.folder('/高考复习/函数'); expect(p.isRoot).toBe(false); expect(p.isVirtual).toBe(false); expect(p.fullPath).toBe('/高考复习/函数'); expect(p.folderPath).toBe('/高考复习/函数'); expect(p.resourceId).toBeUndefined();
  });
  it('test_parsed_path_resource', () => {
    const p = ParsedPath.resource('/高考复习/函数', 'note_abc123', 'note'); expect(p.isRoot).toBe(false); expect(p.isVirtual).toBe(false);
    expect(p.fullPath).toBe('/高考复习/函数/note_abc123'); expect(p.folderPath).toBe('/高考复习/函数'); expect(p.resourceId).toBe('note_abc123'); expect(p.resourceType).toBe('note');
  });
  it('test_parsed_path_resource_at_root', () => {
    const p = ParsedPath.resource(null, 'note_abc123', 'note'); expect(p.fullPath).toBe('/note_abc123'); expect(p.folderPath).toBeUndefined(); expect(p.resourceId).toBe('note_abc123');
  });
  it('test_get_resource_type_from_id', () => {
    for (const [id, type] of [['note_abc123', 'note'], ['tb_xyz789', 'textbook'], ['exam_001', 'exam'], ['tr_123', 'translation'], ['essay_456', 'essay'], ['fld_folder1', 'folder']] as const) expect(getResourceTypeFromId(id)).toBe(type);
    expect(getResourceTypeFromId('unknown_id')).toBeNull(); expect(getResourceTypeFromId('abc123')).toBeNull();
  });
  it('test_is_valid_resource_id', () => {
    for (const id of ['note_abc', 'tb_123', 'fld_folder']) expect(isValidResourceId(id)).toBe(true);
    for (const id of ['abc123', '数学']) expect(isValidResourceId(id)).toBe(false);
  });
  it('test_resource_id_length_limit', () => {
    const valid = `note_${'a'.repeat(123)}`; expect(valid.length).toBe(128); expect(isValidResourceId(valid)).toBe(true);
    const invalid = `note_${'a'.repeat(124)}`; expect(invalid.length).toBe(129); expect(isValidResourceId(invalid)).toBe(false);
    expect(isValidResourceId(`note_${'a'.repeat(500)}`)).toBe(false);
  });
  it('test_is_virtual_path_type', () => {
    for (const t of ['trash', 'recent', 'favorites', 'all', 'TRASH', 'ALL']) expect(isVirtualPathType(t)).toBe(true);
    expect(isVirtualPathType('notes')).toBe(false);
  });
  it('test_parsed_path_get_name', () => {
    expect(ParsedPath.getName(ParsedPath.root())).toBe('/'); expect(ParsedPath.getName(ParsedPath.folder('/高考复习/函数'))).toBe('函数');
    expect(ParsedPath.getName(ParsedPath.resource('/高考复习', 'note_abc', 'note'))).toBe('note_abc');
  });
  it('test_parsed_path_serialization', () => {
    const p = JSON.parse(JSON.stringify(ParsedPath.resource('/高考复习', 'note_abc', 'note')));
    for (const key of ['fullPath', 'folderPath', 'resourceId', 'resourceType']) expect(p).toHaveProperty(key);
    expect(p.isRoot).toBe(false); expect(p.isVirtual).toBe(false);
  });
});
