import { describe, expect, it } from 'vitest';
import {
  TemplateDesignerExecutor, forkCreateRequest, hasUpdateChanges, normalizePatchValue,
  normalizeTemplateValue, parseCreateRequest, parseTemplateArgs, parseUpdateRequest,
  validateTemplateInternal,
} from '../src/template-executor.ts';
import { ensureFieldExtractionRules } from '../src/template-fields.ts';

const rawJson = (text: string): unknown => (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(text);

const rule = (description: string, is_required = true) => ({ field_type: 'Text', is_required, description });
const definition = () => ({
  name: 'Test', description: 'desc', noteType: 'Basic', fields: ['Front', 'Back'],
  frontTemplate: '{{Front}}', backTemplate: '{{Back}}', cssStyle: '.card {}',
  generationPrompt: 'gen', previewFront: 'pf', previewBack: 'pb',
  fieldExtractionRules: { Front: rule('正面'), Back: rule('背面') },
});
const executor = new TemplateDesignerExecutor();

describe('template_executor.rs', () => {
  it('test_can_handle_builtin_prefix', () => {
    for (const name of ['list', 'get', 'validate', 'create', 'update', 'fork', 'preview', 'set_default']) {
      expect(executor.canHandle(`builtin-template_${name}`)).toBe(true);
    }
  });
  it('test_can_handle_mcp_prefix', () => {
    expect(executor.canHandle('mcp_template_list')).toBe(true);
    expect(executor.canHandle('mcp_template_get')).toBe(true);
  });
  it('test_can_handle_bare_name', () => {
    for (const name of ['list', 'get', 'preview']) expect(executor.canHandle(`template_${name}`)).toBe(true);
  });
  it('test_can_handle_unrelated_tools', () => {
    for (const name of ['chatanki_run', 'builtin-web_search', 'builtin-note_read', 'unknown_tool']) expect(executor.canHandle(name)).toBe(false);
  });
  it('test_validate_success', () => {
    expect(validateTemplateInternal(parseCreateRequest(definition()))).toEqual([[], []]);
  });
  it('test_validate_empty_name_and_fields', () => {
    const [errors] = validateTemplateInternal(parseCreateRequest({}));
    expect(errors.length).toBeGreaterThan(0);
    for (const key of ['name', 'fields', 'frontTemplate', 'backTemplate', 'generationPrompt']) {
      expect(errors.some((error) => error.includes(key))).toBe(true);
    }
  });
  it('test_validate_field_rule_mismatch', () => {
    const [errors] = validateTemplateInternal(parseCreateRequest({
      ...definition(), fieldExtractionRules: { Front: rule('正面'), Extra: rule('extra', false) },
    }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((error) => error.includes('Back'))).toBe(true);
    expect(errors.some((error) => error.includes('Extra'))).toBe(true);
  });
  it('test_update_patch_parse_no_expected_version', () => {
    expect(parseUpdateRequest({ name: 'New Name' }).expected_version).toBeNull();
  });
  it('numeric expectedVersion prints as arbitrary_precision Number Display (n.to_string())', () => {
    const version = (value: unknown) => parseUpdateRequest({ expectedVersion: value, name: 'n' }).expected_version;
    expect(version(rawJson('1.0'))).toBe('1.0');
    expect(version(rawJson('2E3'))).toBe('2e+3');
    expect(version(rawJson('-0'))).toBe('0');
    expect(version(rawJson('-0.0'))).toBe('-0.0');
    expect(version(3)).toBe('3');
  });
  it('test_fork_create_request_copies_fields', () => {
    const source = {
      ...parseCreateRequest({ ...definition(), name: 'Source', description: 'Source desc',
        fields: ['Front'], generationPrompt: 'gen prompt', fieldExtractionRules: { Front: rule('正面') } }),
      id: 'src-id', author: 'Author', version: '2.0.0', is_active: true, is_built_in: true,
      created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z', preview_data_json: null,
    };
    const req = forkCreateRequest(source, { sourceTemplateId: 'src-id', name: null, description: null, setActive: true });
    expect(req.name).toBe('Source (副本)');
    expect(req.is_built_in).toBe(false);
    expect(req.fields).toEqual(['Front']);
    expect(req.generation_prompt).toBe('gen prompt');
    expect(req.front_template).toBe('{{Front}}');
    expect(req.field_extraction_rules).toHaveProperty('Front');
  });
  it('test_parse_create_request_camel_case', () => {
    const req = parseCreateRequest(definition());
    expect(req.name).toBe('Test');
    expect(req.note_type).toBe('Basic');
    expect(req.fields).toHaveLength(2);
    expect(Object.keys(req.field_extraction_rules)).toHaveLength(2);
  });
  it('test_parse_create_request_snake_case', () => {
    const req = parseCreateRequest({
      name: 'Test', description: 'desc', note_type: 'Cloze', fields: ['Text', 'Extra'],
      front_template: '{{cloze:Text}}', back_template: '{{cloze:Text}} {{Extra}}', css_style: '',
      generation_prompt: 'gen', preview_front: '', preview_back: '',
      field_extraction_rules: { Text: rule('文本'), Extra: rule('额外', false) },
    });
    expect(req.note_type).toBe('Cloze');
    expect(req.front_template).toBe('{{cloze:Text}}');
  });
  it('test_sensitivity_levels', () => {
    for (const name of ['list', 'get', 'validate', 'preview']) expect(executor.sensitivityLevel(`builtin-template_${name}`)).toBe('low');
    for (const name of ['create', 'update', 'fork', 'set_default']) expect(executor.sensitivityLevel(`builtin-template_${name}`)).toBe('medium');
    expect(executor.sensitivityLevel('builtin-template_delete')).toBe('high');
  });
  it('test_validate_cloze_without_placeholder_fails', () => {
    const [errors] = validateTemplateInternal(parseCreateRequest({ ...definition(), name: 'Cloze Test', noteType: 'Cloze',
      fields: ['Text'], frontTemplate: '{{Text}}', backTemplate: '{{Text}}', fieldExtractionRules: { Text: rule('文本') } }));
    expect(errors.some((error) => error.includes('cloze'))).toBe(true);
  });
  it('test_validate_frontside_on_front_warns', () => {
    const [errors, warnings] = validateTemplateInternal(parseCreateRequest({ ...definition(), fields: ['Front'],
      frontTemplate: '{{FrontSide}} {{Front}}', backTemplate: '{{Front}}', fieldExtractionRules: { Front: rule('正面') } }));
    expect(errors).toEqual([]);
    expect(warnings.some((warning) => warning.includes('FrontSide'))).toBe(true);
  });
  it('test_list_args_defaults', () => {
    expect(parseTemplateArgs('template_list', {})).toEqual({ activeOnly: true, builtinOnly: null, query: null, limit: null });
  });
  it('test_list_args_limit_cap', () => {
    expect(Math.min((parseTemplateArgs('template_list', { limit: 999 }).limit as number | null) ?? 50, 200)).toBe(200);
  });
  it('test_list_args_query', () => {
    expect(parseTemplateArgs('template_list', { query: 'cloze', activeOnly: false })).toMatchObject({ query: 'cloze', activeOnly: false });
  });
  it('test_parse_update_request_camel_case', () => {
    const req = parseUpdateRequest({ expectedVersion: '1.0.0', name: 'Updated Name', noteType: 'Cloze',
      frontTemplate: '<div>{{cloze:Text}}</div>', backTemplate: '<div>{{cloze:Text}}</div>', generationPrompt: 'new prompt',
      cssStyle: '.card { color: red; }', previewFront: 'preview', previewBack: 'preview', isActive: true, isBuiltIn: false, previewDataJson: '{"key":"val"}' });
    expect(req).toMatchObject({ expected_version: '1.0.0', name: 'Updated Name', note_type: 'Cloze',
      front_template: '<div>{{cloze:Text}}</div>', generation_prompt: 'new prompt', css_style: '.card { color: red; }',
      is_active: true, is_built_in: false, preview_data_json: '{"key":"val"}' });
  });
  it('test_parse_update_request_snake_case', () => {
    expect(parseUpdateRequest({ expected_version: '2.1.0', note_type: 'Basic', front_template: '{{Front}}',
      back_template: '{{Back}}', generation_prompt: 'gen' })).toMatchObject({ expected_version: '2.1.0', note_type: 'Basic', front_template: '{{Front}}' });
  });
  it('test_parse_update_request_no_expected_version', () => {
    expect(parseUpdateRequest({ name: 'No Version' }).expected_version).toBeNull();
  });
  it('test_parse_update_request_with_fields_and_rules', () => {
    const req = parseUpdateRequest({ expectedVersion: '1.0.0', fields: ['Front', 'Back', 'Extra'],
      fieldExtractionRules: { Front: rule('正面'), Back: rule('背面'), Extra: rule('额外', false) } });
    expect(req.fields).toHaveLength(3);
    expect(Object.keys(req.field_extraction_rules!)).toHaveLength(3);
    expect(req.field_extraction_rules).toHaveProperty('Extra');
  });
  it('test_get_args_accepts_snake_case_alias', () => {
    expect(parseTemplateArgs('template_get', { template_id: 'tpl-1' }).templateId).toBe('tpl-1');
  });
  it('test_validate_args_accepts_template_definition_alias', () => {
    expect(parseTemplateArgs('template_validate', { templateDefinition: { name: 'x' } }).template).toEqual({ name: 'x' });
  });
  it('test_create_args_accepts_template_definition_alias', () => {
    expect(parseTemplateArgs('template_create', { template_definition: { name: 'x' } }).template).toEqual({ name: 'x' });
  });
  it('test_fork_args_accepts_template_id_alias', () => {
    expect(parseTemplateArgs('template_fork', { templateId: 'src-1' }).sourceTemplateId).toBe('src-1');
  });
  it('test_normalize_patch_value_accepts_json_string_object', () => {
    expect(normalizePatchValue('{"expectedVersion":"1.0.0","name":"new"}').expectedVersion).toBe('1.0.0');
  });
  it('test_normalize_template_value_accepts_json_string_object', () => {
    const normalized = normalizeTemplateValue('{"name":"My Template","fields":["Front","Back"]}');
    expect(normalized.name).toBe('My Template');
    expect(Array.isArray(normalized.fields)).toBe(true);
  });
  it('test_update_args_accepts_top_level_expected_version_alias', () => {
    expect(parseTemplateArgs('template_update', { templateId: 'tpl-1', patch: {}, expected_version: '1.0.0' }).expectedVersion).toBe('1.0.0');
  });
  it('test_update_args_allows_flat_patch_fields_without_patch_object', () => {
    const args = parseTemplateArgs('template_update', { templateId: 'tpl-1', expectedVersion: '1.0.0', name: 'Flat Patch' });
    expect(args.patch).toBeNull();
    expect(args.expectedVersion).toBe('1.0.0');
    expect(args.extra).toEqual({ name: 'Flat Patch' });
  });
  it('arg structs decode like serde_json::from_value (preserve_order, arbitrary_precision, positional form)', () => {
    const errorOf = (tool: string, raw: unknown): string => {
      try { parseTemplateArgs(tool, raw); } catch (caught) { return (caught as Error).message; }
      throw new Error(`${tool} accepted ${JSON.stringify(raw)}`);
    };
    // Present keys decode in input order before missing fields are reported.
    expect(errorOf('template_update', { expectedVersion: 1 })).toBe('invalid type: number, expected a string');
    expect(errorOf('template_fork', { setActive: null })).toBe('invalid type: null, expected a boolean');
    expect(errorOf('template_list', { limit: 'fifty', activeOnly: 'yes' })).toBe('invalid type: string "fifty", expected usize');
    expect(errorOf('template_list', { activeOnly: 'yes', limit: 'fifty' })).toBe('invalid type: string "yes", expected a boolean');
    // arbitrary_precision: usize goes through str::parse.
    expect(errorOf('template_list', { limit: -1 })).toBe('invalid number');
    expect(errorOf('template_list', { limit: 1.5 })).toBe('invalid number');
    expect(errorOf('template_get', { template_id: 'a', templateId: 'b' })).toBe('duplicate field `templateId`');
    expect(errorOf('template_fork', { template_id: 'a', sourceTemplateId: 'b' })).toBe('duplicate field `sourceTemplateId`');
    expect(errorOf('template_create', { name: 'x' })).toBe('missing field `template`');
    expect(errorOf('template_get', 'tpl-1')).toBe('invalid type: string "tpl-1", expected struct TemplateGetArgs');
    expect(errorOf('template_set_default', null)).toBe('invalid type: null, expected struct TemplateSetDefaultArgs');
    // Derived structs take the positional form; the flattened update args only take a map.
    expect(parseTemplateArgs('template_delete', ['tpl-1'])).toEqual({ templateId: 'tpl-1' });
    expect(parseTemplateArgs('template_list', [false])).toEqual({ activeOnly: false, builtinOnly: null, query: null, limit: null });
    expect(errorOf('template_get', [])).toBe('invalid length 0, expected struct TemplateGetArgs with 1 element');
    expect(errorOf('template_update', ['tpl-1'])).toBe('invalid type: sequence, expected struct TemplateUpdateArgs');
    // Explicit nulls on #[serde(default)] Option fields are None; the preview template has no aliases.
    expect(parseTemplateArgs('template_preview', { templateDefinition: { name: 'x' }, template_id: null }))
      .toEqual({ templateId: null, template: null, sampleData: null });
    expect(parseTemplateArgs('template_update', { templateId: 't', template: null, templateDefinitionX: 1 }))
      .toEqual({ templateId: 't', patch: null, template: null, expectedVersion: null, extra: { templateDefinitionX: 1 } });
  });
  it('fieldExtractionRules decode like serde_json::from_value into models.rs FieldExtractionRule', () => {
    const rulesOf = (rules: unknown) => parseCreateRequest({ ...definition(), fieldExtractionRules: rules }).field_extraction_rules;
    const errorOf = (rules: unknown): string => {
      try { rulesOf(rules); } catch (caught) { return (caught as Error).message; }
      throw new Error(`accepted ${JSON.stringify(rules)}`);
    };
    // Serialize shape: struct field order, plain Options as null, skip_serializing_if Options omitted.
    expect(JSON.stringify(rulesOf({ Front: {
      max_length: 10, description: 'd', is_required: false, field_type: { Text: null }, validation: { min: 1 }, transform: null,
    } }).Front)).toBe(JSON.stringify({
      field_type: 'Text', is_required: false, default_value: null, validation_pattern: null, description: 'd',
      validation: { pattern: null, min: 1, max: null, enum_values: null, custom: null, error_message: null }, max_length: 10,
    }));
    expect(rulesOf({ Front: ['Text', true, null, null, '正面'] }).Front).toEqual({
      field_type: 'Text', is_required: true, default_value: null, validation_pattern: null, description: '正面',
    });
    const wrap = (text: string) => `fieldExtractionRules 格式错误: ${text}。请确保每个规则包含 field_type, is_required, description 字段`;
    expect(errorOf({ Front: { ...rule('x'), max_length: -1 } })).toBe(wrap('invalid number'));
    expect(errorOf({ Front: { ...rule('x'), max_length: 'ten' } })).toBe(wrap('invalid type: string "ten", expected u32'));
    expect(errorOf({ Front: { ...rule('x'), validation: { min: 'low' } } })).toBe(wrap('invalid type: string "low", expected f64'));
    expect(errorOf({ Front: { field_type: 'Text', is_required: 1 } })).toBe(wrap('invalid type: number, expected a boolean'));
    expect(errorOf({ Front: ['Text', true] })).toBe(wrap('invalid length 2, expected struct FieldExtractionRule with 16 elements'));
    expect(errorOf({ Front: { ...rule('x'), field_type: 'Code' } }))
      .toBe(wrap('unknown variant `Code`, expected one of `Text`, `Array`, `Number`, `Boolean`, `Date`, `RichText`, `Formula`'));
    expect(errorOf({ Front: { ...rule('x'), field_type: { Text: 1 } } })).toBe(wrap('invalid type: number, expected unit'));
    expect(errorOf({ Front: { ...rule('x'), schema: {} } })).toBe(wrap('missing field `properties`'));
    expect(errorOf(['Front'])).toBe(wrap('invalid type: sequence, expected a map'));
  });
  it('Vec<Value> rule members keep JSON.rawJSON number atoms (a tool argument spelled 1.0)', () => {
    const atom = rawJson('1.0');
    const req = parseCreateRequest({ ...definition(), fieldExtractionRules: {
      Front: { ...rule('正面'), allowed_values: [atom], validation: { enum_values: [atom] } }, Back: rule('背面'),
    } });
    const rules = ensureFieldExtractionRules(['Front', 'Back'], req.field_extraction_rules);
    expect(JSON.stringify(rules.Front)).toBe(JSON.stringify({
      field_type: 'Text', is_required: true, default_value: null, validation_pattern: null, description: '正面',
      validation: { pattern: null, min: null, max: null, enum_values: [atom], custom: null, error_message: null },
      allowed_values: [atom],
    }));
    expect(JSON.stringify(rules.Front!.allowed_values)).toBe('[1.0]');
  });
  it('test_has_update_changes_only_expected_version_returns_false', () => {
    expect(hasUpdateChanges(parseUpdateRequest({ expectedVersion: '1.0.0' }))).toBe(false);
  });
  it('test_has_update_changes_only_is_built_in_returns_false', () => {
    expect(hasUpdateChanges(parseUpdateRequest({ expectedVersion: '1.0.0', isBuiltIn: false }))).toBe(false);
  });
  it('test_list_args_invalid_type_fails', () => {
    expect(() => parseTemplateArgs('template_list', { activeOnly: 'yes' })).toThrow();
  });
  it('test_list_args_invalid_limit_type_fails', () => {
    expect(() => parseTemplateArgs('template_list', { limit: 'fifty' })).toThrow();
  });
  it('test_create_fields_with_non_string_elements_fails', () => {
    expect(() => parseCreateRequest({ ...definition(), fields: [1, 2] })).toThrow('fields[0]');
    expect(() => parseCreateRequest({ ...definition(), fields: [1, 2] })).toThrow('字符串');
  });
  it('test_update_fields_with_non_string_elements_fails', () => {
    expect(() => parseUpdateRequest({ expectedVersion: '1.0.0', fields: ['Front', 42, 'Back'] })).toThrow('fields[1]');
  });
  it('test_update_fields_not_array_fails', () => {
    expect(() => parseUpdateRequest({ expectedVersion: '1.0.0', fields: 'Front,Back' })).toThrow('字符串数组');
  });
  it('test_update_name_wrong_type_fails', () => {
    expect(() => parseUpdateRequest({ expectedVersion: '1.0.0', name: 123 })).toThrow('name');
    expect(() => parseUpdateRequest({ expectedVersion: '1.0.0', name: 123 })).toThrow('字符串');
  });
  it('test_update_is_active_wrong_type_fails', () => {
    expect(() => parseUpdateRequest({ expectedVersion: '1.0.0', isActive: 'yes' })).toThrow('isActive');
    expect(() => parseUpdateRequest({ expectedVersion: '1.0.0', isActive: 'yes' })).toThrow('布尔值');
  });
  it('test_update_expected_version_wrong_type_fails', () => {
    expect(() => parseUpdateRequest({ expectedVersion: true })).toThrow('expectedVersion');
  });
  it('test_update_expected_version_number_is_normalized_to_string', () => {
    expect(parseUpdateRequest({ expectedVersion: 100 }).expected_version).toBe('100');
  });
  it('test_update_args_accepts_template_definition_alias', () => {
    const args = parseTemplateArgs('template_update', { templateId: 'tpl-1',
      template_definition: { expectedVersion: '1.0.0', description: 'patched' } });
    expect(args.patch).toBeNull();
    expect(args.template).not.toBeNull();
  });
  it('test_create_note_type_wrong_type_fails', () => {
    expect(() => parseCreateRequest({ ...definition(), noteType: 42, fields: ['F'], fieldExtractionRules: { F: rule('f') } })).toThrow('noteType');
  });
  it('test_create_is_active_wrong_type_fails', () => {
    expect(() => parseCreateRequest({ ...definition(), isActive: 'true', fields: ['F'], fieldExtractionRules: { F: rule('f') } })).toThrow('isActive');
  });
  it('test_update_null_values_treated_as_absent', () => {
    const req = parseUpdateRequest({ expectedVersion: '1.0.0', name: null, fields: null, isActive: null });
    expect(req.expected_version).toBe('1.0.0');
    expect(req.name).toBeNull();
    expect(req.fields).toBeNull();
    expect(req.is_active).toBeNull();
  });
});

// The DB boundary is the only test double: every branch, message and output shape is
// the production executor's. Rust's own template tests never touch SQLite either.
class FakeTemplateDb {
  templates = new Map<string, any>();
  defaults: string[] = [];
  modified: string[] = [];
  softDeleted: string[] = [];
  deleted: string[] = [];
  referencing = 3;
  failUpdate: string | null = null;
  imported = 0;
  getAllCustomTemplates() { return [...this.templates.values()]; }
  getCustomTemplateById(id: string) { return this.templates.get(id) ?? null; }
  createCustomTemplate(request: any) {
    const id = `tpl-${this.templates.size + 1}`;
    this.templates.set(id, { ...request, id, version: request.version ?? '1.0.0',
      is_active: request.is_active ?? true, is_built_in: request.is_built_in ?? false,
      created_at: '2026-08-24T00:00:00+00:00', updated_at: '2026-08-24T00:00:00+00:00' });
    return id;
  }
  updateCustomTemplate(id: string, request: any) {
    if (this.failUpdate) throw new Error(this.failUpdate);
    const template = this.templates.get(id);
    for (const [key, value] of Object.entries(request)) if (value != null) template[key] = value;
    template.version = '1.0.1';
  }
  markTemplateUserModified(id: string) { this.modified.push(id); }
  countAnkiCardsReferencingTemplate() { return this.referencing; }
  softDeleteBuiltinTemplate(id: string) { this.softDeleted.push(id); }
  deleteCustomTemplate(id: string) { this.deleted.push(id); this.templates.delete(id); }
  setDefaultTemplate(id: string) { this.defaults.push(id); }
  importBuiltinTemplatesIfEmpty() {
    this.imported += 1;
    this.templates.set('builtin-basic', { ...parseCreateRequest(definition()), id: 'builtin-basic',
      version: '1.0.0', is_active: true, is_built_in: true,
      created_at: '2026-08-24T00:00:00+00:00', updated_at: '2026-08-24T00:00:00+00:00' });
  }
}

function harness(db: FakeTemplateDb, extra: Record<string, unknown> = {}) {
  const events: any[] = [];
  const saved: any[] = [];
  const ctx = {
    sessionId: 's', messageId: 'm', blockId: 'blk', mainDb: db,
    emitToolCallStart: (...args: unknown[]) => events.push(['start', ...args]),
    emitToolCallEnd: (value: unknown) => events.push(['end', value]),
    emitToolCallError: (error: string) => events.push(['error', error]),
    saveToolBlock: (value: unknown) => saved.push(value),
    warn: (message: string) => events.push(['warn', message]),
    ...extra,
  };
  return { ctx, events, saved };
}

describe('TemplateDesignerExecutor execution', () => {
  it('template_list imports builtin templates when the library is empty and caps at 200', async () => {
    const db = new FakeTemplateDb();
    const { ctx, events } = harness(db);
    const result = await executor.execute({ id: 'c1', name: 'builtin-template_list', arguments: {} }, ctx as any);
    expect(db.imported).toBe(1);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ count: 1, templates: [{ id: 'builtin-basic', complexityLevel: 'simple',
      fieldExtractionRules: { Front: { field_type: 'Text' } } }] });
    expect(events[0]).toEqual(['start', 'builtin-template_list', {}, 'c1']);
    expect((events[1] as any)[1]).toMatchObject({ result: result.output, durationMs: expect.any(Number) });
    expect(events[2]).toBeUndefined();
    expect(db.templates.size).toBe(1);
  });

  it('template_get emits the full visual payload but returns the compact model payload', async () => {
    const db = new FakeTemplateDb();
    db.createCustomTemplate(parseCreateRequest(definition()) as any);
    const { ctx, events, saved } = harness(db);
    const result = await executor.execute({ id: 'c2', name: 'template_get', arguments: { templateId: 'tpl-1' } }, ctx as any);
    expect(result.output).toEqual({ id: 'tpl-1', name: 'Test', description: 'desc', version: '1.0.0',
      noteType: 'Basic', fields: ['Front', 'Back'], isActive: true, isBuiltIn: false, _visualRendered: true });
    const display = (events[1] as any)[1].result;
    expect(display).toMatchObject({ _templateVisual: true, createdAt: '2026-08-24T00:00:00+00:00',
      frontTemplate: '{{Front}}', previewDataJson: null });
    expect(saved[0].output).toEqual(display);
    expect(saved[0].output).not.toEqual(result.output);
  });

  it('template_get reports the Rust not-found text and persists the failure', async () => {
    const { ctx, events, saved } = harness(new FakeTemplateDb());
    const result = await executor.execute({ id: 'c3', name: 'template_get', arguments: { template_id: 'missing' } }, ctx as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe("模板 'missing' 不存在。请使用 template_list 查看可用模板");
    expect(events[1]).toEqual(['error', result.error]);
    expect(saved[0]).toEqual(result);
  });

  it('template_validate turns parse failures into valid:false instead of a tool failure', async () => {
    const { ctx } = harness(new FakeTemplateDb());
    const result = await executor.execute({ id: 'c4', name: 'template_validate',
      arguments: { template: { name: 'x', fields: [1] } } }, ctx as any);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ valid: false, warnings: [] });
    expect((result.output as any).errors[0]).toContain('fields[0]');
  });

  it('template_create fails closed on validation errors and creates on success', async () => {
    const db = new FakeTemplateDb();
    const { ctx } = harness(db);
    const invalid = await executor.execute({ id: 'c5', name: 'template_create',
      arguments: { template: { ...definition(), fields: [] } } }, ctx as any);
    expect(invalid.success).toBe(false);
    expect(invalid.error).toContain('模板校验失败: fields 不能为空');
    expect(db.templates.size).toBe(0);
    const created = await executor.execute({ id: 'c6', name: 'template_create',
      arguments: { template: definition() } }, ctx as any);
    expect(created.success).toBe(true);
    expect(created.output).toEqual({ created: true, templateId: 'tpl-1', name: 'Test', version: '1.0.0',
      noteType: 'Basic', fields: ['Front', 'Back'], isActive: true, _visualRendered: true });
  });

  it('template_update enforces expectedVersion, honors flat patches and version conflicts', async () => {
    const db = new FakeTemplateDb();
    db.createCustomTemplate(parseCreateRequest(definition()) as any);
    const { ctx } = harness(db);
    const missing = await executor.execute({ id: 'c7', name: 'template_update', arguments: { templateId: 'tpl-1' } }, ctx as any);
    expect(missing.error).toBe('缺少 expectedVersion。请先用 template_get 获取当前版本号，然后在 patch 中传入 expectedVersion');
    const conflict = await executor.execute({ id: 'c8', name: 'template_update',
      arguments: { templateId: 'tpl-1', expectedVersion: '0.9.0', name: 'x' } }, ctx as any);
    expect(conflict.error).toBe('版本冲突：当前版本 1.0.0 与提供的 expectedVersion 0.9.0 不匹配。请先用 template_get 获取最新版本');
    const updated = await executor.execute({ id: 'c9', name: 'template_update',
      arguments: { templateId: 'tpl-1', expectedVersion: '1.0.0', name: 'Flat Patch' } }, ctx as any);
    expect(updated.success).toBe(true);
    expect(updated.output).toMatchObject({ updated: true, name: 'Flat Patch', version: '1.0.1' });
    expect(db.templates.get('tpl-1').name).toBe('Flat Patch');
  });

  it('template_update maps optimistic_lock_failed and marks builtin templates user modified', async () => {
    const db = new FakeTemplateDb();
    db.createCustomTemplate({ ...parseCreateRequest(definition()), is_built_in: true } as any);
    const { ctx } = harness(db);
    db.failUpdate = 'optimistic_lock_failed: stale';
    const locked = await executor.execute({ id: 'c10', name: 'template_update',
      arguments: { templateId: 'tpl-1', expectedVersion: '1.0.0', name: 'x' } }, ctx as any);
    expect(locked.error).toBe('模板已被其他操作更新。请重新用 template_get 获取最新版本后重试');
    db.failUpdate = null;
    await executor.execute({ id: 'c11', name: 'template_update',
      arguments: { templateId: 'tpl-1', expectedVersion: '1.0.0', name: 'y' } }, ctx as any);
    expect(db.modified).toEqual(['tpl-1']);
  });

  it('template_fork defaults the copy name and forces version 1.0.0 / isBuiltIn=false', async () => {
    const db = new FakeTemplateDb();
    db.createCustomTemplate({ ...parseCreateRequest(definition()), is_built_in: true } as any);
    const { ctx } = harness(db);
    const result = await executor.execute({ id: 'c12', name: 'template_fork', arguments: { templateId: 'tpl-1' } }, ctx as any);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ forked: true, templateId: 'tpl-2', sourceTemplateId: 'tpl-1',
      name: 'Test (副本)', isActive: true });
    expect(db.templates.get('tpl-2')).toMatchObject({ version: '1.0.0', is_built_in: false, is_active: true });
  });

  it('template_preview accepts a draft object and echoes missing template ids', async () => {
    const db = new FakeTemplateDb();
    const { ctx } = harness(db);
    const draft = await executor.execute({ id: 'c13', name: 'template_preview',
      arguments: { template: { frontTemplate: 'F', backTemplate: 'B', cssStyle: 'C', fields: ['F'] } } }, ctx as any);
    expect(draft.output).toMatchObject({ previewRendered: true, usedTemplateId: null, fields: ['F'] });
    const missing = await executor.execute({ id: 'c14', name: 'template_preview',
      arguments: { templateId: 'nope' } }, ctx as any);
    expect(missing.error).toBe("模板 'nope' 不存在。请使用 template_list 查看可用模板");
  });

  it('template_delete soft-deletes builtin templates and physically deletes custom ones', async () => {
    const db = new FakeTemplateDb();
    db.createCustomTemplate({ ...parseCreateRequest(definition()), is_built_in: true } as any);
    db.createCustomTemplate(parseCreateRequest({ ...definition(), name: 'Custom' }) as any);
    const { ctx } = harness(db);
    const builtin = await executor.execute({ id: 'c15', name: 'template_delete', arguments: { templateId: 'tpl-1' } }, ctx as any);
    expect(builtin.output).toEqual({ success: true, deleted: false, deactivated: true, isBuiltIn: true,
      templateId: 'tpl-1', templateName: 'Test', referencingCards: 3,
      message: '内置模板「Test」已停用（内置模板不可物理删除，已有 3 张卡片引用不受影响；后续版本升级不会重新启用它）。' });
    expect(db.softDeleted).toEqual(['tpl-1']);
    const custom = await executor.execute({ id: 'c16', name: 'template_delete', arguments: { templateId: 'tpl-2' } }, ctx as any);
    expect(custom.output).toEqual({ success: true, deleted: true, deactivated: false, isBuiltIn: false,
      templateId: 'tpl-2', templateName: 'Custom', referencingCards: 3, message: '模板「Custom」已成功删除。' });
    expect(db.deleted).toEqual(['tpl-2']);
  });

  it('template_set_default rejects inactive templates and succeeds otherwise', async () => {
    const db = new FakeTemplateDb();
    db.createCustomTemplate({ ...parseCreateRequest(definition()), is_active: false } as any);
    const { ctx } = harness(db);
    const inactive = await executor.execute({ id: 'c17', name: 'template_set_default', arguments: { templateId: 'tpl-1' } }, ctx as any);
    expect(inactive.error).toBe('模板「Test」当前为停用状态，不能设为默认模板。请先将其激活');
    db.templates.get('tpl-1').is_active = true;
    const ok = await executor.execute({ id: 'c18', name: 'template_set_default', arguments: { templateId: 'tpl-1' } }, ctx as any);
    expect(ok.output).toEqual({ success: true, templateId: 'tpl-1', templateName: 'Test', message: '已将「Test」设为默认制卡模板。' });
    expect(db.defaults).toEqual(['tpl-1']);
  });

  it('template_delete / template_set_default emit the Rust info logs only after the write succeeds (rs:1505,1533,1605)', async () => {
    const db = new FakeTemplateDb();
    db.createCustomTemplate({ ...parseCreateRequest(definition()), is_built_in: true } as any);
    db.createCustomTemplate(parseCreateRequest({ ...definition(), name: 'Custom' }) as any);
    const infos: string[] = [];
    const { ctx } = harness(db, { info: (message: string) => infos.push(message) });
    const logs = () => infos.filter((line) => !line.includes('execute: tool_name='));
    await executor.execute({ id: 'l1', name: 'template_set_default', arguments: { templateId: 'tpl-1' } }, ctx as any);
    await executor.execute({ id: 'l2', name: 'template_delete', arguments: { templateId: 'tpl-1' } }, ctx as any);
    await executor.execute({ id: 'l3', name: 'template_delete', arguments: { templateId: 'tpl-2' } }, ctx as any);
    expect(logs()).toEqual([
      '[TemplateDesignerExecutor] Set default template: id=tpl-1, name=Test',
      '[TemplateDesignerExecutor] Soft-deleted builtin template: id=tpl-1, name=Test',
      '[TemplateDesignerExecutor] Deleted template: id=tpl-2, name=Custom',
    ]);
    db.setDefaultTemplate = () => { throw new Error('locked'); };
    db.createCustomTemplate(parseCreateRequest({ ...definition(), name: 'Third' }) as any);
    const failed = await executor.execute({ id: 'l4', name: 'template_set_default', arguments: { templateId: 'tpl-2' } }, ctx as any);
    expect(failed.error).toBe('设置默认模板失败: locked');
    expect(logs()).toHaveLength(3);
  });

  it('save_tool_block failures are discarded without a log on every emit path (rs:217,238,275)', async () => {
    const db = new FakeTemplateDb();
    db.createCustomTemplate(parseCreateRequest(definition()) as any);
    const { ctx, events } = harness(db, { saveToolBlock: () => { throw new Error('db down'); } });
    const failed = await executor.execute({ id: 'p1', name: 'template_get', arguments: { templateId: 'missing' } }, ctx as any);
    const plain = await executor.execute({ id: 'p2', name: 'template_set_default', arguments: { templateId: 'tpl-1' } }, ctx as any);
    const visual = await executor.execute({ id: 'p3', name: 'template_get', arguments: { templateId: 'tpl-1' } }, ctx as any);
    expect([failed.success, plain.success, visual.success]).toEqual([false, true, true]);
    expect(events.filter((event) => event[0] === 'warn')).toEqual([]);
  });

  it('template_update falls back to before when the re-read fails, without failing or logging (rs:1167-1185)', async () => {
    const db = new FakeTemplateDb();
    db.createCustomTemplate(parseCreateRequest(definition()) as any);
    const { ctx, events } = harness(db);
    const read = db.getCustomTemplateById.bind(db);
    let calls = 0;
    db.getCustomTemplateById = (id: string) => {
      calls += 1;
      if (calls > 1) throw new Error('reread failed');
      return structuredClone(read(id)); // a real DB read returns an owned row, like Rust
    };
    const result = await executor.execute({ id: 'u1', name: 'template_update',
      arguments: { templateId: 'tpl-1', expectedVersion: '1.0.0', name: 'Renamed' } }, ctx as any);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ updated: true, name: 'Test', version: null });
    const display = (events.find((event) => event[0] === 'end') as any)[1].result;
    expect(display.after).toEqual(display.before);
    expect(events.filter((event) => event[0] === 'warn')).toEqual([]);
  });

  it('unknown template tools are executor errors, not tool results', async () => {
    const { ctx } = harness(new FakeTemplateDb());
    await expect(executor.execute({ id: 'c19', name: 'builtin-template_nope', arguments: {} }, ctx as any))
      .rejects.toThrow('Unsupported template designer tool: template_nope');
  });
});
