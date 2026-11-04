import { describe, expect, it } from 'vitest';

import { createCspSafeJsonSchemaValidator } from '@/mcp/cspSafeJsonSchemaValidator';

import { getBuiltinToolSkillById } from '../builtin-tools';
import type { JsonSchemaProperty, SkillDefinition, ToolInputSchema, ToolSchema } from '../types';

const schemaValidator = createCspSafeJsonSchemaValidator();

function schemaAccepts(schema: ToolInputSchema, input: unknown): boolean {
  return schemaValidator.getValidator(schema)(input).valid;
}

const inkToolNames = [
  'builtin-ink_prepare',
  'builtin-ink_create',
  'builtin-ink_get',
  'builtin-ink_render',
  'builtin-ink_apply_ops',
  'builtin-ink_export',
];

function getInkSkill(): SkillDefinition {
  const skill = getBuiltinToolSkillById('ink-tools');
  expect(skill, 'ink-tools must be registered as a builtin skill').toBeDefined();
  if (!skill) throw new Error('ink-tools is not registered');
  return skill;
}

function getTool(skill: SkillDefinition, name: string): ToolSchema {
  const matches = skill.embeddedTools?.filter((tool) => tool.name === name) ?? [];
  expect(matches, `${skill.id} must expose ${name} exactly once`).toHaveLength(1);
  return matches[0];
}

function getOperationSchema(schema: JsonSchemaProperty, operation: string): JsonSchemaProperty {
  const operationSchema = schema.items;
  expect(operationSchema?.properties?.op?.enum).toContain(operation);
  const found = operationSchema?.oneOf?.find((candidate) => candidate.properties?.op?.enum?.includes(operation));
  expect(found, `apply_ops must define ${operation}`).toBeDefined();
  if (!found || !operationSchema) throw new Error(`apply_ops is missing ${operation}`);
  return {
    ...operationSchema,
    ...found,
    properties: { ...operationSchema.properties, ...found.properties },
  };
}

function collectPropertyNames(schema: unknown, names = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== 'object') return names;
  const record = schema as Record<string, unknown>;
  if (record.properties && typeof record.properties === 'object') {
    for (const [name, property] of Object.entries(record.properties)) {
      names.add(name);
      collectPropertyNames(property, names);
    }
  }
  collectPropertyNames(record.items, names);
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const variants = record[key];
    if (Array.isArray(variants)) variants.forEach((variant) => collectPropertyNames(variant, names));
  }
  return names;
}

describe('ink builtin tool schemas', () => {
  it('registers exactly the six first-release ink tools on the builtin skill', () => {
    const skill = getInkSkill();

    expect(skill.location).toBe('builtin');
    expect(skill.isBuiltin).toBe(true);
    expect([...skill.allowedTools ?? []].sort()).toEqual([...inkToolNames].sort());
    expect(skill.embeddedTools?.map((tool) => tool.name).sort()).toEqual([...inkToolNames].sort());
  });

  it('declares prepare, create, get, render, and export inputs from the Chat contract', () => {
    const skill = getInkSkill();
    const prepare = getTool(skill, 'builtin-ink_prepare').inputSchema;
    const create = getTool(skill, 'builtin-ink_create').inputSchema;
    const get = getTool(skill, 'builtin-ink_get').inputSchema;
    const renderTool = getTool(skill, 'builtin-ink_render');
    const render = renderTool.inputSchema;
    const exportTool = getTool(skill, 'builtin-ink_export');
    const exportSchema = exportTool.inputSchema;

    expect(prepare.required).toEqual(['source_resource_id', 'operation_id']);
    expect(prepare.properties.source_resource_id).toMatchObject({ type: 'string', minLength: 1 });
    expect(prepare.properties.operation_id).toMatchObject({ type: 'string', minLength: 1 });

    expect(create.required).toEqual(['title', 'operation_id']);
    expect(create.properties.title).toMatchObject({ type: 'string', minLength: 1 });
    expect(create.properties.page_size).toBeDefined();
    expect(create.properties.ruling).toMatchObject({ type: 'string', enum: ['blank', 'lined', 'grid'] });
    expect(create.properties.folder_id).toMatchObject({ type: 'string' });

    expect(render.required).toEqual(['document_id', 'expected_revision', 'page_id']);
    expect(render.properties.document_id).toMatchObject({ type: 'string', minLength: 1 });
    expect(render.properties.expected_revision).toMatchObject({ type: 'string', minLength: 1 });
    expect(render.properties.page_id).toMatchObject({ type: 'string', minLength: 1 });
    expect(render.properties.crop).toMatchObject({ type: 'object' });
    expect(renderTool.description).toContain('render_id');

    expect(exportSchema.required).toEqual([
      'document_id',
      'expected_revision',
      'page_ids',
      'format',
      'operation_id',
    ]);
    expect(exportSchema.properties.page_ids).toMatchObject({ type: 'array', minItems: 1 });
    expect(exportSchema.properties.format).toMatchObject({ type: 'string', enum: ['png', 'pdf'] });
    expect(exportTool.description).toMatch(/不(?:会)?覆盖/);

    expect(schemaAccepts(prepare, { source_resource_id: 'res-source', operation_id: 'prepare-1' })).toBe(true);
    expect(schemaAccepts(prepare, { source_resource_id: 'res-source' })).toBe(false);
    expect(schemaAccepts(create, {
      title: 'Notes',
      operation_id: 'create-1',
      page_size: { width: 595, height: 842 },
      ruling: 'lined',
    })).toBe(true);
    expect(schemaAccepts(create, {
      title: 'Notes',
      operation_id: 'create-1',
      page_size: { width: 0, height: 842 },
    })).toBe(false);
    expect(schemaAccepts(get, { document_id: 'doc-1' })).toBe(true);
    expect(schemaAccepts(get, { document_id: 'doc-1', page_index: 0 })).toBe(true);
    expect(schemaAccepts(get, { document_id: 'doc-1', page_index: 1.5 })).toBe(false);
    expect(schemaAccepts(get, { document_id: 'doc-1', page_id: 'page-1' })).toBe(true);
    expect(schemaAccepts(get, { document_id: 'doc-1', page_id: 'page-1', page_index: 0 })).toBe(false);
    expect(schemaAccepts(render, {
      document_id: 'doc-1',
      expected_revision: 'rev-1',
      page_id: 'page-1',
    })).toBe(true);
    expect(schemaAccepts(render, { document_id: 'doc-1', page_id: 'page-1' })).toBe(false);
    expect(schemaAccepts(exportSchema, {
      document_id: 'doc-1',
      expected_revision: 'rev-1',
      page_ids: ['page-1'],
      format: 'pdf',
      operation_id: 'export-1',
    })).toBe(true);
    expect(schemaAccepts(exportSchema, {
      document_id: 'doc-1',
      expected_revision: 'rev-1',
      page_ids: [],
      format: 'pdf',
      operation_id: 'export-1',
    })).toBe(false);
  });

  it('keeps recognition read-only and requires exact confirmation for destructive object edits', () => {
    const skill = getInkSkill();
    const prompt = skill.content;
    const applyOps = getTool(skill, 'builtin-ink_apply_ops').inputSchema;
    const update = getOperationSchema(applyOps.properties.ops, 'update_object');
    const remove = getOperationSchema(applyOps.properties.ops, 'remove_object');

    expect(prompt).toContain('只请求识别、解释、总结或查看时，不调用写入工具');
    expect(prompt).toContain('每次都须先向用户展示精确页/对象范围并取得确认');
    expect(prompt).toContain('对象作者未知时');
    expect(prompt).toContain('本地固定页图');
    expect(prompt).toContain('质量警告');
    expect(update.required).toContain('object_id');
    expect(remove.required).toContain('object_id');
    expect(remove.properties.object_id.description).toContain('精确范围用户确认');
  });

  it('requires revision-bound, render-bound inputs for localized operations and caps batches at 100', () => {
    const skill = getInkSkill();
    const applyOps = getTool(skill, 'builtin-ink_apply_ops').inputSchema;
    const operations = applyOps.properties.ops;

    expect(applyOps.required).toEqual(['document_id', 'expected_revision', 'operation_id', 'ops']);
    expect(applyOps.properties.document_id).toMatchObject({ type: 'string', minLength: 1 });
    expect(applyOps.properties.expected_revision).toMatchObject({ type: 'string', minLength: 1 });
    expect(applyOps.properties.operation_id).toMatchObject({ type: 'string', minLength: 1 });
    expect(operations).toMatchObject({ type: 'array', minItems: 1, maxItems: 100 });

    for (const operation of [
      'add_text',
      'add_rect',
      'add_ellipse',
      'add_arrow',
      'add_region_highlight',
      'update_object',
    ]) {
      expect(getOperationSchema(operations, operation).required).toEqual(
        expect.arrayContaining(['page_id', 'coordinate_space', 'based_on_render_id']),
      );
    }
    const get = getTool(skill, 'builtin-ink_get').inputSchema;
    expect(get.required).toEqual(['document_id']);
    expect(get.properties.document_id).toMatchObject({ type: 'string', minLength: 1 });
    expect(get.properties.page_index).toMatchObject({ type: 'integer', minimum: 0 });
    expect(get.properties.page_id).toMatchObject({ type: 'string', minLength: 1 });
    expect(get.properties.operation_id).toMatchObject({ type: 'string', minLength: 1 });
    expect(skill.content).toMatch(/page_index[^\n]*(?:0-based|从 ?0 开始)/i);
  });

  it('limits apply_ops to text and shape edits, not SVG, HTML, scripts, paths, or dense strokes', () => {
    const skill = getInkSkill();
    const applyOps = getTool(skill, 'builtin-ink_apply_ops').inputSchema;
    const operationNames = applyOps.properties.ops.items?.oneOf?.flatMap(
      (operation) => operation.properties?.op?.enum ?? [],
    );
    const propertyNames = collectPropertyNames(applyOps);

    expect(operationNames).toEqual([
      'append_blank_page',
      'add_text',
      'add_rect',
      'add_ellipse',
      'add_region_highlight',
      'add_arrow',
      'update_object',
      'remove_object',
    ]);
    for (const forbidden of ['svg', 'html', 'script', 'path', 'samples']) {
      expect(propertyNames).not.toContain(forbidden);
    }
    expect(getOperationSchema(applyOps.properties.ops, 'add_text').properties?.text).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 10000,
    });
  });

  it('validates representative bounded operation payloads and rejects unknown or unbounded input', () => {
    const skill = getInkSkill();
    const applyOps = getTool(skill, 'builtin-ink_apply_ops').inputSchema;
    const base = {
      document_id: 'doc-1',
      expected_revision: 'rev-1',
      operation_id: 'op-1',
    };
    const renderBound = {
      page_id: 'page-1',
      coordinate_space: 'page',
      based_on_render_id: 'render-1',
    };
    const valid = (op: unknown) => schemaAccepts(applyOps, { ...base, ops: [op] });

    expect(valid({
      op: 'add_text',
      ...renderBound,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      text: 'Check this step',
      font_size: 16,
      color: '#ff0000',
    })).toBe(true);
    expect(valid({
      op: 'add_text',
      page_id: 'page-1',
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      text: 'Missing render provenance',
      font_size: 16,
      color: '#ff0000',
    })).toBe(false);
    expect(valid({
      op: 'add_text',
      ...renderBound,
      coordinate_space: 'viewport',
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      text: 'Unknown coordinate space',
      font_size: 16,
      color: '#ff0000',
    })).toBe(false);
    expect(valid({ op: 'append_blank_page', width: 595, height: 842, ruling: 'blank' })).toBe(true);
    expect(valid({ op: 'append_blank_page', width: 1.5, height: 842, ruling: 'blank' })).toBe(false);
    expect(valid({ op: 'append_blank_page', width: 595, height: 842, ruling: 'blank', page_id: 'model-invented' })).toBe(false);
    expect(valid({
      op: 'add_rect',
      ...renderBound,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      color: '#ff0000',
      width: 2,
    })).toBe(true);
    expect(valid({
      op: 'add_ellipse',
      ...renderBound,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      color: '#ff0000',
      width: 2,
    })).toBe(true);
    expect(valid({
      op: 'add_region_highlight',
      ...renderBound,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      color: '#ff0000',
      width: 2,
    })).toBe(true);
    expect(valid({
      op: 'add_arrow',
      ...renderBound,
      from: { x: 0.1, y: 0.2 },
      to: { x: 0.8, y: 0.9 },
      color: '#ff0000',
      width: 2,
    })).toBe(true);
    expect(valid({
      op: 'update_object',
      ...renderBound,
      object_id: 'object-1',
      content: {
        kind: 'text',
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        text: 'Updated note',
        font_size: 16,
        color: '#ff0000',
      },
    })).toBe(true);
    expect(valid({
      op: 'add_rect',
      ...renderBound,
      rect: { x: -0.1, y: 0.2, width: 0.3, height: 0.1 },
      color: '#ff0000',
      width: 2,
    })).toBe(false);
    expect(valid({
      op: 'add_text',
      ...renderBound,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      text: '<script>alert(1)</script>',
      font_size: 16,
      color: '#ff0000',
    })).toBe(true);
    expect(valid({
      op: 'add_text',
      ...renderBound,
      html: '<svg><script/></svg>',
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      text: 'literal text only',
      font_size: 16,
      color: '#ff0000',
    })).toBe(false);
    expect(valid({ op: 'add_stroke', ...renderBound, samples: [{ x: 0.2, y: 0.3 }] })).toBe(false);
    expect(valid({
      op: 'add_rect',
      ...renderBound,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      color: '#ff0000',
      width: 0,
    })).toBe(false);
    expect(valid({ op: 'remove_object', page_id: 'page-1', object_id: 'object-1' })).toBe(true);
    expect(valid({ op: 'remove_object', page_id: 'page-1' })).toBe(false);
    expect(schemaAccepts(applyOps, { ...base, ops: Array(101).fill({ op: 'append_blank_page', width: 1, height: 1, ruling: 'blank' }) })).toBe(false);
  });

  // Proposed E2 wire contract: `mode` is optional and defaults to paged.
  // A board create has no fixed page, so it must not require `page_size`.
  it('accepts an explicit board create mode without page_size and keeps unknown fields rejected', () => {
    const skill = getInkSkill();
    const create = getTool(skill, 'builtin-ink_create').inputSchema;

    expect(create.properties.mode, 'create.mode is the proposed optional paged|board discriminator').toBeDefined();
    expect(create.properties.mode).toMatchObject({
      type: 'string',
      enum: ['paged', 'board'],
      default: 'paged',
    });
    expect(create.required).not.toContain('mode');
    expect(create.required).not.toContain('page_size');
    expect(schemaAccepts(create, {
      title: 'Paged default',
      operation_id: 'create-paged',
    })).toBe(true);
    expect(schemaAccepts(create, {
      title: 'Board',
      operation_id: 'create-board',
      mode: 'board',
    })).toBe(true);
    expect(schemaAccepts(create, {
      title: 'Board',
      operation_id: 'create-board',
      mode: 'viewport',
    })).toBe(false);
    expect(schemaAccepts(create, {
      title: 'Board',
      operation_id: 'create-board',
      mode: 'board',
      surprise: true,
    })).toBe(false);
    expect(schemaAccepts(create, {
      title: 'Board',
      operation_id: 'create-board',
      page_size: { width: 595, height: 842 },
    })).toBe(true);
  });

  // Proposed E2 wire contract: paged render keeps normalized `crop`; board
  // render adds an absolute world `board_crop`. The two are exclusive.
  it('accepts a finite absolute board_crop on render while keeping normalized crop paged', () => {
    const skill = getInkSkill();
    const render = getTool(skill, 'builtin-ink_render').inputSchema;
    const base = {
      document_id: 'doc-1',
      expected_revision: 'rev-1',
      page_id: 'page-1',
    };

    expect(render.properties.board_crop, 'render.board_crop is the proposed absolute world rect').toBeDefined();
    expect(render.properties.board_crop).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'width', 'height'],
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
    });
    expect(schemaAccepts(render, {
      ...base,
      board_crop: { x: -100, y: -50, width: 800, height: 600 },
    })).toBe(true);
    expect(schemaAccepts(render, {
      ...base,
      crop: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    })).toBe(true);
    expect(schemaAccepts(render, {
      ...base,
      crop: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      board_crop: { x: 0, y: 0, width: 800, height: 600 },
    })).toBe(false);
    expect(schemaAccepts(render, {
      ...base,
      board_crop: { x: 0, y: 0, width: 0, height: 600 },
    })).toBe(false);
    expect(schemaAccepts(render, {
      ...base,
      board_crop: { x: 0, y: 0, width: 800, height: 600, scale: 2 },
    })).toBe(false);
  });

  // Proposed E2 wire contract: board export carries a finite world region and
  // exactly one surface page id. Old paged export remains valid unchanged.
  it('accepts a finite board export region with a single surface page and preserves paged export', () => {
    const skill = getInkSkill();
    const exportSchema = getTool(skill, 'builtin-ink_export').inputSchema;
    const base = {
      document_id: 'doc-1',
      expected_revision: 'rev-1',
      page_ids: ['surface-1'],
      format: 'pdf',
      operation_id: 'export-1',
    };
    const board = {
      region: { x: -100, y: -50, width: 800, height: 600 },
      page_width: 800,
      page_height: 600,
      paginate: true,
    };

    expect(exportSchema.properties.board, 'export.board is the proposed finite board region payload').toBeDefined();
    expect(exportSchema.properties.board).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        region: { type: 'object' },
        page_width: { type: 'number' },
        page_height: { type: 'number' },
        paginate: { type: 'boolean' },
      },
    });
    expect(exportSchema.properties.board?.required).toContain('region');
    expect(exportSchema.properties.board?.properties?.region).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'width', 'height'],
    });
    expect(schemaAccepts(exportSchema, { ...base, board })).toBe(true);
    expect(schemaAccepts(exportSchema, {
      ...base,
      board: {
        region: { x: 0, y: 0, width: 800, height: 600 },
        page_width: 800,
        page_height: 600,
      },
    })).toBe(true);
    expect(schemaAccepts(exportSchema, {
      ...base,
      page_ids: ['surface-1', 'surface-2'],
      board,
    })).toBe(false);
    expect(schemaAccepts(exportSchema, {
      ...base,
      board: { ...board, region: { x: 0, y: 0, width: 0, height: 600 } },
    })).toBe(false);
    expect(schemaAccepts(exportSchema, {
      ...base,
      board: { ...board, unexpected: 1 },
    })).toBe(false);
    expect(schemaAccepts(exportSchema, base)).toBe(true);
  });

  // Budget guard: measure the real serialized schema payload. Do not raise the
  // independent Ink cap or delete strict schemas to fit it.
  it('measures the real ink schema payload against the independent <=3000 token budget', () => {
    const skill = getInkSkill();
    const serialized = JSON.stringify(skill.embeddedTools);
    const estimatedTokens = Math.ceil(serialized.length / 4);

    expect(
      estimatedTokens,
      `Ink schema payload is ${serialized.length} chars ≈ ${estimatedTokens} tokens; the independent cap is 3000`,
    ).toBeLessThanOrEqual(3000);
  });
});
