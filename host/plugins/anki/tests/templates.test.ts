import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import type { CreateTemplateRequest, CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import {
  compareTemplateVersion,
  decideBuiltinImportAction,
  extractTemplateFieldRefs,
  shouldUpdateBuiltinTemplate,
  validateTemplateRequest,
  type DecodedFieldExtractionRule,
} from '../src/templates.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

function makeRule(description: string): DecodedFieldExtractionRule {
  return {
    field_type: 'Text',
    is_required: false,
    default_value: null,
    validation_pattern: null,
    description,
  };
}

function makeTemplateRequest(
  noteType: string,
  fields: string[],
  front: string,
  back: string,
): CreateTemplateRequest {
  const rules: Record<string, DecodedFieldExtractionRule> = {};
  for (const field of fields) rules[field] = makeRule(`${field}字段`);
  return {
    name: '测试模板',
    description: 'desc',
    author: null,
    version: '1.0.0',
    preview_front: '',
    preview_back: '',
    note_type: noteType,
    fields,
    generation_prompt: 'gen',
    front_template: front,
    back_template: back,
    css_style: '',
    field_extraction_rules: rules,
    preview_data_json: null,
    is_active: true,
    is_built_in: null,
  };
}

describe('src/commands.rs::tests（模板纯逻辑）', () => {
  it('compare_template_version_handles_semver_like_versions', () => {
    expect(compareTemplateVersion('2.1.0', '2.1.1')).toBe(-1);
    expect(compareTemplateVersion('2.1.1', '2.1.1')).toBe(0);
    expect(compareTemplateVersion('2.2.0', '2.1.9')).toBe(1);
    expect(compareTemplateVersion('2.1', '2.1.0')).toBe(0);
  });

  it('compare_template_version_tolerates_non_standard_versions', () => {
    expect(shouldUpdateBuiltinTemplate('legacy', '2.0.0')).toBe(true);
    expect(shouldUpdateBuiltinTemplate('2.1.0', 'beta')).toBe(false);
  });

  it('builtin_import_skips_user_deleted_templates', () => {
    expect(decideBuiltinImportAction(false, true, '1.0.0', '2.0.0')).toEqual({
      kind: 'preserve',
      reason: '用户已删除，保持停用不复活',
    });
    expect(decideBuiltinImportAction(true, true, '1.0.0', '2.0.0')).toEqual({
      kind: 'preserve',
      reason: '用户已删除，保持停用不复活',
    });
  });

  it('builtin_import_skips_user_modified_templates', () => {
    expect(decideBuiltinImportAction(true, false, '1.0.0', '2.0.0')).toEqual({
      kind: 'preserve',
      reason: '用户已修改，保留用户版本',
    });
  });

  it('builtin_import_updates_untouched_templates_by_version', () => {
    expect(decideBuiltinImportAction(false, false, '1.0.0', '2.0.0')).toEqual({ kind: 'update' });
    expect(decideBuiltinImportAction(false, false, '2.0.0', '2.0.0')).toEqual({ kind: 'skip' });
    expect(decideBuiltinImportAction(false, false, '2.1.0', '2.0.0')).toEqual({ kind: 'skip' });
  });

  it('extract_template_field_refs_handles_conditionals_filters_and_specials', () => {
    const refs = extractTemplateFieldRefs(
      '{{Front}} {{#Extra}}{{cloze:Text}}{{/Extra}} {{^Hint}}x{{/Hint}} ' +
      '{{type:cloze:Answer}} {{FrontSide}} {{Tags}}',
    );
    expect(refs.has('Front')).toBe(true);
    expect(refs.has('Extra')).toBe(true);
    expect(refs.has('Text')).toBe(true);
    expect(refs.has('Hint')).toBe(true);
    expect(refs.has('Answer')).toBe(true);
    expect(refs.has('FrontSide')).toBe(false);
    expect(refs.has('Tags')).toBe(false);
  });

  it('validate_template_request_rejects_cloze_without_placeholder', () => {
    const request = makeTemplateRequest('Cloze', ['Text', 'Extra'], '{{Text}}', '{{Text}} {{Extra}}');
    const error = validateTemplateRequest(request);
    expect(error).not.toBeNull();
    expect(error).toContain('cloze');
  });

  it('validate_template_request_accepts_valid_cloze_and_basic_templates', () => {
    const cloze = makeTemplateRequest('Cloze', ['Text', 'Extra'], '{{cloze:Text}}', '{{cloze:Text}} {{Extra}}');
    expect(validateTemplateRequest(cloze)).toBeNull();
    const basicWithUnknownRef = makeTemplateRequest('Basic', ['Front'], '{{Front}}', '{{FrontSide}} {{Back}}');
    expect(validateTemplateRequest(basicWithUnknownRef)).toBeNull();
  });
});

describe('模板命令（真实 mistakes 库）', () => {
  let env: AnkiTestEnv;
  beforeEach(async () => {
    env = await createAnkiTestEnv();
  }, 60_000);
  afterEach(async () => {
    await env.dispose();
  });

  async function createTemplate(): Promise<string> {
    return env.host.invoke<string>('create_custom_template', { request: makeTemplateRequest('Basic', ['Front'], '{{Front}}', '{{Front}}') });
  }

  it('persists field_extraction_rules in the FieldExtractionRule serde shape on create and update', async () => {
    const storedRules = (templateId: string) => env.storage.database('mistakes').pluck<string>(
      'SELECT field_extraction_rules_json FROM custom_anki_templates WHERE id = ?1', [templateId]);
    const request = makeTemplateRequest('Basic', ['Front', 'Back'], '{{Front}}', '{{Back}}');
    request.field_extraction_rules = {
      Front: { field_type: 'Text', is_required: true, description: '问题', max_length: 30, unknown_key: 'dropped' },
      Back: { description: '答案', is_required: true, field_type: 'Text' },
    } as unknown as CreateTemplateRequest['field_extraction_rules'];
    const templateId = await env.host.invoke<string>('create_custom_template', { request });
    expect(storedRules(templateId)).toBe('{"Front":{"field_type":"Text","is_required":true,"default_value":null,'
      + '"validation_pattern":null,"description":"问题","max_length":30},"Back":{"field_type":"Text","is_required":true,'
      + '"default_value":null,"validation_pattern":null,"description":"答案"}}');

    await env.host.invoke('update_custom_template', { templateId, request: { expected_version: '1.0.0', field_extraction_rules: {
      Front: { description: 'Q', is_required: false, field_type: 'Text' },
      Back: { field_type: 'Text', is_required: false, description: 'A', default_value: '无' },
    } } });
    expect(storedRules(templateId)).toBe('{"Front":{"field_type":"Text","is_required":false,"default_value":null,'
      + '"validation_pattern":null,"description":"Q"},"Back":{"field_type":"Text","is_required":false,'
      + '"default_value":"无","validation_pattern":null,"description":"A"}}');
  });

  it('nested ValidationRule/TransformRule/ObjectSchema keep Rust serde shape: f64 .0, plain Options as null, recursive rules', async () => {
    const request = makeTemplateRequest('Basic', ['Front'], '{{Front}}', '{{Front}}');
    request.field_extraction_rules = {
      Front: { field_type: 'Number', is_required: true, description: '分值',
        validation: { max: 100, min: 0.5, error_message: '范围' },
        transform: { transform_type: 'trim' },
        schema: { properties: { Sub: { field_type: 'Text', is_required: false, description: '子', min_length: 1 } } },
        allowed_values: [1, 'x'] },
    } as unknown as CreateTemplateRequest['field_extraction_rules'];
    const templateId = await env.host.invoke<string>('create_custom_template', { request });
    expect(env.storage.database('mistakes').pluck<string>(
      'SELECT field_extraction_rules_json FROM custom_anki_templates WHERE id = ?1', [templateId]))
      .toBe('{"Front":{"field_type":"Number","is_required":true,"default_value":null,"validation_pattern":null,"description":"分值",'
        + '"validation":{"pattern":null,"min":0.5,"max":100.0,"enum_values":null,"custom":null,"error_message":"范围"},'
        + '"transform":{"transform_type":"trim","format":null,"custom_function":null},'
        + '"schema":{"properties":{"Sub":{"field_type":"Text","is_required":false,"default_value":null,"validation_pattern":null,'
        + '"description":"子","min_length":1}},"required":null},"allowed_values":[1,"x"]}}');
  });

  it('creates, reads, updates and deletes a user template', async () => {
    expect(await env.host.invoke('get_all_custom_templates')).toEqual([]);
    const templateId = await createTemplate();
    const templates = await env.host.invoke<CustomAnkiTemplate[]>('get_all_custom_templates');
    expect(templates).toHaveLength(1);
    expect(templates[0]?.id).toBe(templateId);
    expect(templates[0]?.name).toBe('测试模板');
    expect(templates[0]?.version).toBe('1.0.0');

    await env.host.invoke('update_custom_template', {
      templateId,
      request: { name: '改名模板', expected_version: '1.0.0' },
    });
    const updated = await env.host.invoke<CustomAnkiTemplate | null>('get_custom_template_by_id', { templateId });
    expect(updated?.name).toBe('改名模板');
    expect(updated?.version).toBe('1.0.1');

    await expect(env.host.invoke('update_custom_template', {
      templateId,
      request: { name: '再次改名', expected_version: '1.0.0' },
    })).rejects.toMatchObject({ error_type: 'Validation', message: '模板已被更新，请刷新后重试' });

    expect(await env.host.invoke('count_custom_template_references', { templateId })).toBe(0);
    const deleted = await env.host.invoke<Record<string, unknown>>('delete_custom_template', { templateId });
    expect(deleted).toMatchObject({ deleted: true, deactivated: false, isBuiltIn: false, referencingCards: 0, message: '模板「改名模板」已删除' });
    expect(await env.host.invoke('get_custom_template_by_id', { templateId })).toBeNull();
  });

  it('rejects version-less and unknown-template updates with Rust messages', async () => {
    const templateId = await createTemplate();
    await expect(env.host.invoke('update_custom_template', { templateId, request: { name: 'x' } }))
      .rejects.toMatchObject({ message: '模板版本缺失，请刷新后重试' });
    await expect(env.host.invoke('update_custom_template', { templateId: 'missing', request: { name: 'x', expected_version: '1.0.0' } }))
      .rejects.toMatchObject({ message: '模板不存在' });
    await expect(env.host.invoke('delete_custom_template', { templateId: 'missing' }))
      .rejects.toMatchObject({ message: '模板不存在' });
  });

  it('exports, imports with overwrite (stable id) and bulk imports', async () => {
    const templateId = await createTemplate();
    const exported = await env.host.invoke<{ template_data: string }>('export_template', { templateId });
    const parsed = JSON.parse(exported.template_data) as CustomAnkiTemplate;
    expect(parsed.id).toBe(templateId);
    expect(parsed.fields).toEqual(['Front']);

    await expect(env.host.invoke('import_template', { request: { template_data: exported.template_data, overwrite_existing: false } }))
      .rejects.toMatchObject({ message: "模板 '测试模板' 已存在，请启用覆盖或修改名称后重试" });
    expect(await env.host.invoke<string>('import_template', { request: { template_data: exported.template_data, overwrite_existing: true } })).toBe(templateId);

    const bulk = await env.host.invoke<string>('import_custom_templates_bulk', {
      request: { template_data: JSON.stringify([parsed]), overwrite_existing: true },
    });
    expect(bulk).toBe('导入完成: 1 个成功, 0 个跳过(已存在)');
    const strict = await env.host.invoke<string>('import_custom_templates_bulk', {
      request: {
        template_data: JSON.stringify([{
          ...parsed,
          fields_json: JSON.stringify(parsed.fields),
          field_extraction_rules_json: JSON.stringify(parsed.field_extraction_rules),
        }]),
        overwrite_existing: false,
        strict_builtin: true,
      },
    });
    expect(strict).toBe('导入完成: 0 个成功, 1 个跳过(已存在), 1 个冲突(已跳过): 测试模板。请启用覆盖或修改名称后重试');
  });

  it('imports builtin templates idempotently and deactivates a deleted builtin', async () => {
    const first = await env.host.invoke<string>('import_builtin_templates');
    expect(first).toBe('导入完成: 16 个新增, 0 个更新, 0 个跳过');
    const second = await env.host.invoke<string>('import_builtin_templates');
    expect(second).toBe('导入完成: 0 个新增, 0 个更新, 16 个跳过');

    const templates = await env.host.invoke<CustomAnkiTemplate[]>('get_all_custom_templates');
    expect(templates).toHaveLength(16);
    const builtin = templates.find((template) => template.id === 'design-lab');
    expect(builtin?.is_built_in).toBe(true);

    const deleted = await env.host.invoke<Record<string, unknown>>('delete_custom_template', { templateId: 'design-lab' });
    expect(deleted).toMatchObject({ deleted: false, deactivated: true, isBuiltIn: true, referencingCards: 0 });
    expect(String(deleted.message)).toContain('内置模板「The Lab (学术选择题)」已停用');
    const afterDelete = await env.host.invoke<string>('import_builtin_templates');
    expect(afterDelete).toContain('1 个保留用户状态(已跳过): The Lab (学术选择题)(用户已删除，保持停用不复活)');
  });

  it('round-trips the default template id and writes debug JSON', async () => {
    expect(await env.host.invoke('get_default_template_id')).toBeNull();
    await env.host.invoke('set_default_template', { templateId: 'design-lab' });
    expect(await env.host.invoke('get_default_template_id')).toBe('design-lab');

    const file = await env.host.invoke<string>('save_template_debug_data', { debugData: { b: 2, a: [1, 'x'] } });
    expect(path.dirname(file)).toBe(path.join(env.dir, 'template_debug'));
    const text = await readFile(file, 'utf8');
    expect(JSON.parse(text)).toEqual({ b: 2, a: [1, 'x'] });
    expect(text.startsWith('{\n  "b": 2,')).toBe(true);
    await rm(file);
  });
});
