import { describe, expect, it } from 'vitest';

import { indexWebpageToolsSkill } from '../builtin-tools/index-webpage-tools';

function tool(name: string) {
  const matches = indexWebpageToolsSkill.embeddedTools?.filter((entry) => entry.name === name) ?? [];
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe('phase 8 index and webpage tool contracts', () => {
  it('keeps progressive disclosure closed over the three required tools', () => {
    expect(indexWebpageToolsSkill.allowedTools).toEqual(
      indexWebpageToolsSkill.embeddedTools?.map((entry) => entry.name),
    );
    expect(new Set(indexWebpageToolsSkill.allowedTools).size).toBe(3);
    expect(indexWebpageToolsSkill.content).toContain('vfs-index-progress');
    expect(indexWebpageToolsSkill.content).toContain('hasMore=false');
    expect(indexWebpageToolsSkill.content).toContain('deduplicated=true');
  });

  it('bounds status pagination and requires VFS resource IDs when scoped', () => {
    const schema = tool('builtin-index_status').inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.resource_id.pattern).toBe('^res_[A-Za-z0-9_-]+$');
    expect(schema.properties.page.minimum).toBe(1);
    expect(schema.properties.page_size.maximum).toBe(20);
    expect(tool('builtin-index_status').description).toContain('2000');
  });

  it('makes rebuild a targeted full-index operation with a strict schema', () => {
    const schema = tool('builtin-index_rebuild').inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['resource_id']);
    expect(schema.properties.resource_id.pattern).toBe('^res_[A-Za-z0-9_-]+$');
    expect(schema.properties.folder_id.pattern).toBe('^[A-Za-z0-9_-]+$');
    expect(tool('builtin-index_rebuild').description).toContain('High');
    expect(tool('builtin-index_rebuild').description).toContain('VfsFullIndexingService');
  });

  it('requires complete bounded fetched content and preserves source metadata', () => {
    const schema = tool('builtin-webpage_save').inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['url', 'content']);
    expect(schema.properties.url.pattern).toBe('^https?://');
    expect(schema.properties.url.maxLength).toBe(4096);
    expect(schema.properties.title.maxLength).toBe(300);
    expect(schema.properties.content.maxLength).toBe(1000000);
    expect(tool('builtin-webpage_save').description).toContain('blob + source metadata');
    expect(tool('builtin-webpage_save').description).toContain('Medium');
  });
});
