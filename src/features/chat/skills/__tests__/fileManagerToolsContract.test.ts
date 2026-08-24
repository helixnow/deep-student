import { describe, expect, it } from 'vitest';
import { fileManagerToolsSkill } from '../builtin-tools/file-manager-tools';

const tool = (name: string) => fileManagerToolsSkill.embeddedTools.find((item) => item.name === name)!;

describe('file manager skill contract', () => {
  it('exposes only plan, commit, and restore', () => {
    expect(fileManagerToolsSkill.allowedTools).toEqual(['builtin-file_manager_plan', 'builtin-file_manager_commit', 'builtin-file_manager_restore']);
  });
  it('bounds planning to workspace-relative supported operations', () => {
    const schema = tool('builtin-file_manager_plan').inputSchema as any;
    expect(schema.required).toEqual(['root_id', 'items']);
    expect(schema.properties.root_id.enum).toEqual(['workspace']);
    expect(schema.properties.items).toMatchObject({ minItems: 1, maxItems: 100 });
    expect(schema.properties.items.items.properties.operation.enum).toEqual(['rename', 'move', 'delete', 'format_convert']);
    expect(schema.properties.items.items.properties.format.enum).toEqual(['json_pretty', 'json_compact', 'csv_to_tsv', 'tsv_to_csv']);
  });
  it('binds commit to exact plan root and preview hash', () => {
    const schema = tool('builtin-file_manager_commit').inputSchema as any;
    expect(schema.required).toEqual(['plan_id', 'root_id', 'preview_sha256']);
    expect(schema.properties.root_id.enum).toEqual(['workspace']);
    expect(schema.properties.preview_sha256.pattern).toContain('{64}');
    expect(tool('builtin-file_manager_commit').description).toContain('re-hashed');
  });
  it('requires a soft-delete receipt and excludes permanent delete', () => {
    const schema = tool('builtin-file_manager_restore').inputSchema as any;
    expect(schema.properties.receipt.required).toEqual(expect.arrayContaining(['receiptId', 'sessionId', 'rootId', 'originalPath', 'trashPath', 'sha256']));
    expect(fileManagerToolsSkill.content).toContain('Permanent deletion is not supported');
    expect(fileManagerToolsSkill.content).toContain('backend alone chooses');
    expect(fileManagerToolsSkill.content).toContain('non-transactional');
  });
});
