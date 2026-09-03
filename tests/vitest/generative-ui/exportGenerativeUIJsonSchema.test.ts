import { describe, expect, it } from 'vitest';
import { MAX_GENERATIVE_UI_BLOCKS } from '@/features/generative-ui/schema';
import {
  GENERATIVE_UI_JSON_SCHEMA_ID,
  exportGenerativeUIJsonSchema,
} from '@/features/generative-ui/utils/exportGenerativeUIJsonSchema';

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toEqual(expect.any(Object));
  return value as Record<string, unknown>;
}

function schemaBlocks(schema: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(schema.properties).blocks);
}

function schemaBlockType(schema: Record<string, unknown>): Record<string, unknown> {
  const items = asRecord(schemaBlocks(schema).items);
  return asRecord(asRecord(items.properties).type);
}

describe('exportGenerativeUIJsonSchema', () => {
  it('exports a draft-07 object schema for GenerativeUIIntent', () => {
    const schema = exportGenerativeUIJsonSchema();
    expect(GENERATIVE_UI_JSON_SCHEMA_ID).toBe('generative-ui-intent');
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.title).toBe('GenerativeUIIntent');
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(expect.arrayContaining(['blocks']));
  });

  it('documents version enum 1 and 1.1', () => {
    const schema = exportGenerativeUIJsonSchema();
    const version = asRecord(asRecord(schema.properties).version);
    expect(version.enum).toEqual(['1', '1.1']);
  });

  it('caps blocks.maxItems at MAX_GENERATIVE_UI_BLOCKS', () => {
    const schema = exportGenerativeUIJsonSchema();
    const blocks = schemaBlocks(schema);
    expect(blocks.maxItems).toBe(32);
    expect(blocks.maxItems).toBe(MAX_GENERATIVE_UI_BLOCKS);
  });

  it('lists 18 registered block types including markdown, chart, steps, table, stat-card, action-bar', () => {
    const schema = exportGenerativeUIJsonSchema();
    const registered = schema['x-registered-block-types'];
    expect(registered).toEqual(expect.any(Array));
    expect(registered).toHaveLength(18);
    expect(registered).toEqual(
      expect.arrayContaining([
        'markdown',
        'chart',
        'steps',
        'table',
        'stat-card',
        'action-bar',
      ]),
    );
    expect(registered).toEqual([...(registered as string[])].sort());
    expect(schemaBlockType(schema).enum).toEqual(registered);
  });

  it('is JSON-serializable with no function values', () => {
    const schema = exportGenerativeUIJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it('is deterministic across calls', () => {
    expect(exportGenerativeUIJsonSchema()).toEqual(exportGenerativeUIJsonSchema());
  });
});
