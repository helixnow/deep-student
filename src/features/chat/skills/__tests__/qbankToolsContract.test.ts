import { describe, expect, it } from 'vitest';
import { qbankToolsSkill } from '../builtin-tools/qbank-tools';

describe('qbank ACR 3.0 write contract', () => {
  it('requires an OCC baseline and structured image descriptors', () => {
    const tool = qbankToolsSkill.embeddedTools?.find(
      (candidate) => candidate.name === 'builtin-qbank_update_question',
    );
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toContain('expected_updated_at');
    expect(tool!.inputSchema.additionalProperties).toBe(false);

    const imageItems = tool!.inputSchema.properties.images.items;
    expect(imageItems).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['id'],
    });
    expect(tool!.inputSchema.properties.expected_updated_at).toMatchObject({
      type: 'string',
      minLength: 1,
    });
  });

  it('lets import_document take a library resource_id instead of base64 content', () => {
    const tool = qbankToolsSkill.embeddedTools?.find(
      (candidate) => candidate.name === 'builtin-qbank_import_document',
    );
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties.resource_id).toMatchObject({ type: 'string' });
    expect(tool!.inputSchema.required ?? []).not.toContain('content');
    expect(tool!.inputSchema.anyOf).toEqual([
      { required: ['resource_id'] },
      { required: ['content'] },
    ]);
    expect(tool!.description).toContain('resource_id');
    expect(qbankToolsSkill.content).toContain('resource_id');
  });

  it('defines get_question.updated_at as the update baseline', () => {
    const get = qbankToolsSkill.embeddedTools?.find(
      (candidate) => candidate.name === 'builtin-qbank_get_question',
    );
    expect(get?.description).toContain('updated_at');
  });
});
