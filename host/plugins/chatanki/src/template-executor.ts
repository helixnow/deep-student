import type {
  ChatAnkiSettingsStore, ChatAnkiToolExecutor, CreateTemplateRequest, CustomAnkiTemplate, TemplateDatabase, ToolCall,
  ToolExecutionContext, ToolResultInfo, ToolSensitivity, UpdateTemplateRequest,
} from '../api.ts';
import { errorText, stripToolNamespace, toolResult } from './execution.ts';
import { publishedAppError } from './result.ts';
import {
  deserializeSerdeStruct, isSerdeMap, serdeBool, serdeInvalidType, serdeOption, serdeString, serdeUsize,
  type SerdeStructField,
} from './serde-struct.ts';
import {
  calculateComplexityLevel, ensureFieldExtractionRules, extractFields, hasUpdateChanges,
  normalizeTemplateFields, parseCreateRequest, parseUpdateRequest, validateTemplateInternal,
  valueTypeLabel,
} from './template-fields.ts';

export { hasUpdateChanges, parseCreateRequest, parseUpdateRequest, validateTemplateInternal };

const TEMPLATE_TOOLS = [
  'template_list', 'template_get', 'template_validate', 'template_create', 'template_update',
  'template_fork', 'template_preview', 'template_delete', 'template_set_default',
];

export interface ParsedTemplateArgs {
  activeOnly?: boolean;
  builtinOnly?: boolean | null;
  query?: string | null;
  limit?: number | null;
  templateId?: string | null;
  template?: unknown;
  patch?: unknown | null;
  expectedVersion?: string | null;
  extra?: Record<string, unknown>;
  sourceTemplateId?: string | null;
  name?: string | null;
  description?: string | null;
  setActive?: boolean;
  sampleData?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const serdeValue = (value: unknown): unknown => value;
const optionString = serdeOption(serdeString);
const TEMPLATE_VALUE_ALIASES = ['templateDefinition', 'template_definition'];
const TEMPLATE_ID_FIELDS: readonly SerdeStructField[] = [
  { name: 'templateId', aliases: ['template_id'], read: serdeString },
];
const TEMPLATE_VALUE_FIELDS: readonly SerdeStructField[] = [
  { name: 'template', aliases: TEMPLATE_VALUE_ALIASES, read: serdeValue },
];
const TEMPLATE_LIST_FIELDS: readonly SerdeStructField[] = [
  { name: 'activeOnly', default: true, read: serdeBool },
  { name: 'builtinOnly', default: true, read: serdeOption(serdeBool) },
  { name: 'query', default: true, read: optionString },
  { name: 'limit', default: true, read: serdeOption(serdeUsize) },
];
const TEMPLATE_UPDATE_FIELDS: readonly SerdeStructField[] = [
  ...TEMPLATE_ID_FIELDS,
  { name: 'patch', default: true, read: serdeOption(serdeValue) },
  { name: 'template', aliases: TEMPLATE_VALUE_ALIASES, default: true, read: serdeOption(serdeValue) },
  { name: 'expectedVersion', aliases: ['expected_version'], default: true, read: optionString },
];
const TEMPLATE_UPDATE_KEYS = new Set(TEMPLATE_UPDATE_FIELDS.flatMap((field) => [field.name, ...(field.aliases ?? [])]));
const TEMPLATE_FORK_FIELDS: readonly SerdeStructField[] = [
  { name: 'sourceTemplateId', aliases: ['source_template_id', 'templateId', 'template_id'], read: serdeString },
  { name: 'name', default: true, read: optionString },
  { name: 'description', default: true, read: optionString },
  { name: 'setActive', default: true, read: serdeBool },
];
const TEMPLATE_PREVIEW_FIELDS: readonly SerdeStructField[] = [
  { name: 'templateId', aliases: ['template_id'], default: true, read: optionString },
  { name: 'template', default: true, read: serdeOption(serdeValue) },
  { name: 'sampleData', default: true, read: serdeOption(serdeValue) },
];

/**
 * `serde_json::from_value` of the template_executor.rs:52–146 arg structs (unknown keys ignored).
 * `TemplateUpdateArgs` has a `#[serde(flatten)]` map, so it decodes through `deserialize_map`:
 * no positional form, and the unknown keys become `extra`.
 */
export function parseTemplateArgs(tool: string, raw: unknown): ParsedTemplateArgs {
  switch (stripToolNamespace(tool)) {
    case 'template_list': {
      const [activeOnly, builtinOnly, query, limit] = deserializeSerdeStruct(raw, 'TemplateListArgs', TEMPLATE_LIST_FIELDS, false);
      return {
        activeOnly: (activeOnly ?? true) as boolean,
        builtinOnly: (builtinOnly ?? null) as boolean | null,
        query: (query ?? null) as string | null,
        limit: limit === undefined || limit === null ? null : Number(limit),
      };
    }
    case 'template_get':
      return { templateId: deserializeSerdeStruct(raw, 'TemplateGetArgs', TEMPLATE_ID_FIELDS, false)[0] as string };
    case 'template_delete':
      return { templateId: deserializeSerdeStruct(raw, 'TemplateDeleteArgs', TEMPLATE_ID_FIELDS, false)[0] as string };
    case 'template_set_default':
      return { templateId: deserializeSerdeStruct(raw, 'TemplateSetDefaultArgs', TEMPLATE_ID_FIELDS, false)[0] as string };
    case 'template_validate':
      return { template: deserializeSerdeStruct(raw, 'TemplateValidateArgs', TEMPLATE_VALUE_FIELDS, false)[0] };
    case 'template_create':
      return { template: deserializeSerdeStruct(raw, 'TemplateCreateArgs', TEMPLATE_VALUE_FIELDS, false)[0] };
    case 'template_update': {
      if (!isSerdeMap(raw)) serdeInvalidType(raw, 'struct TemplateUpdateArgs');
      const [templateId, patch, template, expectedVersion] = deserializeSerdeStruct(
        raw, 'TemplateUpdateArgs', TEMPLATE_UPDATE_FIELDS, false,
      );
      return {
        templateId: templateId as string,
        patch: patch ?? null,
        template: template ?? null,
        expectedVersion: (expectedVersion ?? null) as string | null,
        extra: Object.fromEntries(Object.entries(raw).filter(([key]) => !TEMPLATE_UPDATE_KEYS.has(key))),
      };
    }
    case 'template_fork': {
      const [sourceTemplateId, name, description, setActive] = deserializeSerdeStruct(
        raw, 'TemplateForkArgs', TEMPLATE_FORK_FIELDS, false,
      );
      return {
        sourceTemplateId: sourceTemplateId as string,
        name: (name ?? null) as string | null,
        description: (description ?? null) as string | null,
        setActive: (setActive ?? true) as boolean,
      };
    }
    case 'template_preview': {
      const [templateId, template, sampleData] = deserializeSerdeStruct(
        raw, 'TemplatePreviewArgs', TEMPLATE_PREVIEW_FIELDS, false,
      );
      return { templateId: (templateId ?? null) as string | null, template: template ?? null, sampleData: sampleData ?? null };
    }
    default:
      return {};
  }
}

export function normalizePatchValue(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (error) {
      throw new Error(`patch 是字符串但不是合法 JSON：${errorText(error)}。请传入对象或可解析的 JSON 字符串`);
    }
    if (!isRecord(parsed)) throw new Error(`patch JSON 必须是对象，实际为 ${valueTypeLabel(parsed)}。请传入如 {"expectedVersion":"1.0.0"} 的对象`);
    return parsed;
  }
  throw new Error(`patch 必须是对象，实际收到 ${valueTypeLabel(raw)}。请传入对象（不要传数组/数字）`);
}

export function normalizeTemplateValue(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (error) {
      throw new Error(`template 是字符串但不是合法 JSON：${errorText(error)}。请传入对象或可解析的 JSON 字符串`);
    }
    if (!isRecord(parsed)) throw new Error(`template JSON 必须是对象，实际为 ${valueTypeLabel(parsed)}。请传入模板对象`);
    return parsed;
  }
  throw new Error(`template 必须是对象，实际收到 ${valueTypeLabel(raw)}。请传入模板对象`);
}

function templateFields(t: CustomAnkiTemplate): string[] {
  return t.fields.map((field) => field);
}

export function forkCreateRequest(
  source: CustomAnkiTemplate,
  args: { sourceTemplateId: string; name: string | null; description: string | null; setActive: boolean },
): CreateTemplateRequest {
  return {
    name: args.name ?? `${source.name} (副本)`,
    description: args.description ?? source.description,
    author: source.author, version: '1.0.0',
    preview_front: source.preview_front, preview_back: source.preview_back,
    note_type: source.note_type, fields: templateFields(source),
    generation_prompt: source.generation_prompt, front_template: source.front_template,
    back_template: source.back_template, css_style: source.css_style,
    field_extraction_rules: structuredClone(source.field_extraction_rules),
    preview_data_json: source.preview_data_json, is_active: args.setActive, is_built_in: false,
  };
}

type Emit = (value: unknown) => void;

type TemplateService = NonNullable<ToolExecutionContext['templates']>;
type TemplateStore =
  | { kind: 'db'; db: TemplateDatabase }
  | { kind: 'service'; templates: TemplateService; settings: ChatAnkiSettingsStore };

/** dstu-storage `set_default_template` (mod.rs:7225–7240) writes this settings key. */
const DEFAULT_TEMPLATE_SETTING_KEY = 'default_template_id';

/** L16 throws `CommandError(AppError)`; Rust formats the inner error text, not an envelope. */
function storeErrorText(error: unknown): string {
  return publishedAppError(error)?.message ?? errorText(error);
}

function listTemplates(store: TemplateStore): CustomAnkiTemplate[] {
  return store.kind === 'db' ? store.db.getAllCustomTemplates() : store.templates.list();
}

function getTemplate(store: TemplateStore, id: string): CustomAnkiTemplate | null {
  return store.kind === 'db' ? store.db.getCustomTemplateById(id) : store.templates.get(id);
}

function createTemplate(store: TemplateStore, request: CreateTemplateRequest): string {
  return store.kind === 'db' ? store.db.createCustomTemplate(request) : store.templates.create(request);
}

function importBuiltinTemplatesIfEmpty(store: TemplateStore): void {
  if (store.kind === 'db') store.db.importBuiltinTemplatesIfEmpty();
  else store.templates.importBuiltinTemplatesIfEmpty();
}

/**
 * dstu-storage `update_custom_template` (mod.rs:2713–2836) reports a CAS miss
 * (`affected == 0` with expected_version) as `optimistic_lock_failed`. The L16
 * facade reports the same miss — a row changed or vanished after the executor's
 * own existence/version check — as these two Validation messages.
 */
function updateTemplate(store: TemplateStore, id: string, request: UpdateTemplateRequest): void {
  if (store.kind === 'db') { store.db.updateCustomTemplate(id, request); return; }
  try { store.templates.update(id, request); }
  catch (error) {
    const app = publishedAppError(error);
    if (app?.error_type === 'Validation' && (app.message === '模板已被更新，请刷新后重试' || app.message === '模板不存在')) {
      throw new Error('optimistic_lock_failed');
    }
    throw error;
  }
}

export class TemplateDesignerExecutor implements ChatAnkiToolExecutor {
  canHandle(name: string): boolean { return TEMPLATE_TOOLS.includes(stripToolNamespace(name)); }
  name(): string { return 'TemplateDesignerExecutor'; }
  sensitivityLevel(name: string): ToolSensitivity {
    switch (stripToolNamespace(name)) {
      case 'template_delete': return 'high';
      case 'template_create':
      case 'template_fork':
      case 'template_update':
      case 'template_set_default': return 'medium';
      default: return 'low';
    }
  }
  concurrencyClass(): 'serial' { return 'serial'; }

  /**
   * template_executor.rs:191–198 `get_db`: main_db, then anki_db. In the Host
   * both are the L16 `mistakes` owner, published as `anki.templates`
   * (+ `settings` for the default-template row), so the hydrated service is
   * the production store when no raw TemplateDatabase is supplied.
   */
  private static getDb(ctx: ToolExecutionContext): TemplateStore {
    const db = ctx.mainDb ?? ctx.ankiDb;
    if (db) return { kind: 'db', db };
    if (ctx.templates && ctx.settings) return { kind: 'service', templates: ctx.templates, settings: ctx.settings };
    throw new Error('数据库不可用，请稍后重试或检查应用状态');
  }

  private static fail(call: ToolCall, ctx: ToolExecutionContext, error: string, started: number): ToolResultInfo {
    const durationMs = Math.floor(performance.now() - started);
    ctx.emitToolCallError(error);
    const result = toolResult(call, ctx, durationMs, null, error);
    try { ctx.saveToolBlock(result); }
    catch { /* boundary-allow empty-catch: template_executor.rs:217 `let _ = ctx.save_tool_block(..)` discards the persist error without a log (best-effort, result unchanged) */ }
    return result;
  }

  private static succeed(call: ToolCall, ctx: ToolExecutionContext, output: unknown, started: number): ToolResultInfo {
    const durationMs = Math.floor(performance.now() - started);
    ctx.emitToolCallEnd({ result: output, durationMs });
    const result = toolResult(call, ctx, durationMs, output);
    try { ctx.saveToolBlock(result); }
    catch { /* boundary-allow empty-catch: template_executor.rs:238 `let _ = ctx.save_tool_block(..)` discards the persist error without a log (best-effort, result unchanged) */ }
    return result;
  }

  /** chatanki_executor.rs style dual channel: display to the UI, compact output to the model. */
  private static succeedVisual(
    call: ToolCall, ctx: ToolExecutionContext, display: unknown, model: unknown, started: number,
  ): ToolResultInfo {
    const durationMs = Math.floor(performance.now() - started);
    ctx.emitToolCallEnd({ result: display, durationMs });
    const result = toolResult(call, ctx, durationMs, model);
    try { ctx.saveToolBlock({ ...result, output: display }); }
    catch { /* boundary-allow empty-catch: template_executor.rs:275 `let _ = ctx.save_tool_block(..)` discards the persist error without a log (best-effort, result unchanged) */ }
    return result;
  }

  private static argFailure(call: ToolCall, ctx: ToolExecutionContext, prefix: string, error: unknown, suffix: string, started: number): ToolResultInfo {
    const message = `${prefix}${errorText(error)}${suffix}`;
    return TemplateDesignerExecutor.fail(call, ctx, message, started);
  }

  private list(call: ToolCall, ctx: ToolExecutionContext, started: number): ToolResultInfo {
    let args: ParsedTemplateArgs;
    try { args = parseTemplateArgs('template_list', call.arguments); }
    catch (error) {
      return TemplateDesignerExecutor.argFailure(call, ctx, '参数格式错误: ', error,
        '。支持的参数: activeOnly(bool), builtinOnly(bool), query(string), limit(number)', started);
    }
    let db: TemplateStore;
    try { db = TemplateDesignerExecutor.getDb(ctx); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
    let all: CustomAnkiTemplate[];
    try { all = listTemplates(db); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `查询模板失败: ${storeErrorText(error)}。请检查数据库状态`, started); }
    if (all.length === 0) {
      let imported = false;
      try { importBuiltinTemplatesIfEmpty(db); imported = true; }
      catch (error) { ctx.warn(`[TemplateDesignerExecutor] auto-import builtin templates failed: ${errorText(error)}`); }
      // template_executor.rs:766 `else if let Ok(v) = db.get_all_custom_templates()`: a failed re-read keeps the empty list.
      if (imported) {
        try { all = listTemplates(db); }
        catch { all = []; }
      }
    }
    const limit = Math.min(args.limit ?? 50, 200);
    const query = args.query === null || args.query === undefined ? null : args.query.toLowerCase();
    const templates = all.filter((t) => {
      if (args.activeOnly && !t.is_active) return false;
      if (args.builtinOnly === true && !t.is_built_in) return false;
      if (query !== null) {
        const hay = `${t.id} ${t.name}\n${t.description}`.toLowerCase();
        if (!hay.includes(query) && !t.note_type.toLowerCase().includes(query)) return false;
      }
      return true;
    }).slice(0, limit).map((t) => {
      const fields = normalizeTemplateFields(t.fields);
      const rules = ensureFieldExtractionRules(fields, t.field_extraction_rules);
      return {
        id: t.id, name: t.name, description: t.description, version: t.version,
        isActive: t.is_active, isBuiltIn: t.is_built_in, noteType: t.note_type, fields,
        complexityLevel: calculateComplexityLevel(fields.length, t.note_type),
        fieldExtractionRules: rules, generationPrompt: t.generation_prompt,
      };
    });
    return TemplateDesignerExecutor.succeed(call, ctx, { count: templates.length, templates }, started);
  }

  private get(call: ToolCall, ctx: ToolExecutionContext, started: number): ToolResultInfo {
    let args: ParsedTemplateArgs;
    try { args = parseTemplateArgs('template_get', call.arguments); }
    catch (error) { return TemplateDesignerExecutor.argFailure(call, ctx, '参数错误: ', error, '。请提供 templateId', started); }
    let db: TemplateStore;
    try { db = TemplateDesignerExecutor.getDb(ctx); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
    let template: CustomAnkiTemplate | null;
    try { template = getTemplate(db, args.templateId as string); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `查询模板失败: ${storeErrorText(error)}。请稍后重试`, started); }
    if (!template) return TemplateDesignerExecutor.fail(call, ctx, `模板 '${args.templateId}' 不存在。请使用 template_list 查看可用模板`, started);
    const display = {
      _templateVisual: true, id: template.id, name: template.name, description: template.description,
      author: template.author, version: template.version, previewFront: template.preview_front,
      previewBack: template.preview_back, noteType: template.note_type, fields: template.fields,
      generationPrompt: template.generation_prompt, frontTemplate: template.front_template,
      backTemplate: template.back_template, cssStyle: template.css_style,
      fieldExtractionRules: template.field_extraction_rules, isActive: template.is_active,
      isBuiltIn: template.is_built_in, createdAt: template.created_at, updatedAt: template.updated_at,
      previewDataJson: template.preview_data_json,
    };
    const model = {
      id: template.id, name: template.name, description: template.description,
      version: template.version, noteType: template.note_type, fields: template.fields,
      isActive: template.is_active, isBuiltIn: template.is_built_in, _visualRendered: true,
    };
    return TemplateDesignerExecutor.succeedVisual(call, ctx, display, model, started);
  }

  private validate(call: ToolCall, ctx: ToolExecutionContext, started: number): ToolResultInfo {
    let args: ParsedTemplateArgs;
    try { args = parseTemplateArgs('template_validate', call.arguments); }
    catch (error) { return TemplateDesignerExecutor.argFailure(call, ctx, '参数错误: ', error, '。请提供 template 对象', started); }
    let normalized: Record<string, unknown>;
    try { normalized = normalizeTemplateValue(args.template); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
    let req: CreateTemplateRequest;
    try { req = parseCreateRequest(normalized); }
    catch (error) {
      return TemplateDesignerExecutor.succeed(call, ctx, { valid: false, errors: [errorText(error)], warnings: [] }, started);
    }
    const [errors, warnings] = validateTemplateInternal(req);
    return TemplateDesignerExecutor.succeed(call, ctx, { valid: errors.length === 0, errors, warnings }, started);
  }

  private create(call: ToolCall, ctx: ToolExecutionContext, started: number): ToolResultInfo {
    let args: ParsedTemplateArgs;
    try { args = parseTemplateArgs('template_create', call.arguments); }
    catch (error) { return TemplateDesignerExecutor.argFailure(call, ctx, '参数错误: ', error, '。请提供 template 对象', started); }
    let req: CreateTemplateRequest;
    try { req = parseCreateRequest(normalizeTemplateValue(args.template)); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
    const [errors] = validateTemplateInternal(req);
    if (errors.length) return TemplateDesignerExecutor.fail(call, ctx, `模板校验失败: ${errors.join('; ')}。请修正后重试`, started);
    let db: TemplateStore;
    try { db = TemplateDesignerExecutor.getDb(ctx); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
    let templateId: string;
    try { templateId = createTemplate(db, req); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `创建模板失败: ${storeErrorText(error)}。请检查数据是否完整`, started); }
    const version = req.version ?? '1.0.0';
    const isActive = req.is_active ?? true;
    const display = {
      _templateVisual: true, created: true, templateId, name: req.name, version, noteType: req.note_type,
      fields: req.fields, frontTemplate: req.front_template, backTemplate: req.back_template,
      cssStyle: req.css_style, previewDataJson: req.preview_data_json, isActive,
    };
    const model = {
      created: true, templateId, name: req.name, version, noteType: req.note_type,
      fields: req.fields, isActive, _visualRendered: true,
    };
    return TemplateDesignerExecutor.succeedVisual(call, ctx, display, model, started);
  }

  private update(call: ToolCall, ctx: ToolExecutionContext, started: number): ToolResultInfo {
    let args: ParsedTemplateArgs;
    try { args = parseTemplateArgs('template_update', call.arguments); }
    catch (error) { return TemplateDesignerExecutor.argFailure(call, ctx, '参数错误: ', error, '。请提供 templateId 和 patch', started); }
    const extra = args.extra ?? {};
    const rawPatch = args.patch ?? args.template ?? Object.fromEntries(Object.entries(extra).filter(([key]) =>
      key !== 'templateId' && key !== 'template_id' && key !== 'expectedVersion' && key !== 'expected_version'));
    let updateReq: UpdateTemplateRequest;
    try { updateReq = parseUpdateRequest(normalizePatchValue(rawPatch)); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `patch 格式错误: ${errorText(error)}。请参考 template_get 的返回结构`, started); }
    if (updateReq.expected_version == null) updateReq.expected_version = args.expectedVersion ?? null;
    if (updateReq.is_built_in != null) updateReq.is_built_in = null;
    if (updateReq.expected_version == null) {
      return TemplateDesignerExecutor.fail(call, ctx, '缺少 expectedVersion。请先用 template_get 获取当前版本号，然后在 patch 中传入 expectedVersion', started);
    }
    if (!hasUpdateChanges(updateReq)) {
      return TemplateDesignerExecutor.fail(call, ctx, 'patch 中未检测到可更新字段。请至少传入一个变更字段（如 name/frontTemplate/backTemplate/cssStyle）', started);
    }
    let db: TemplateStore;
    try { db = TemplateDesignerExecutor.getDb(ctx); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
    let existing: CustomAnkiTemplate | null;
    try { existing = getTemplate(db, args.templateId as string); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `查询模板失败: ${storeErrorText(error)}`, started); }
    if (!existing) return TemplateDesignerExecutor.fail(call, ctx, `模板 '${args.templateId}' 不存在。请使用 template_list 查看可用模板`, started);
    if (updateReq.expected_version !== existing.version) {
      return TemplateDesignerExecutor.fail(call, ctx,
        `版本冲突：当前版本 ${existing.version} 与提供的 expectedVersion ${updateReq.expected_version} 不匹配。请先用 template_get 获取最新版本`, started);
    }
    const before = {
      name: existing.name, frontTemplate: existing.front_template, backTemplate: existing.back_template,
      cssStyle: existing.css_style, fields: existing.fields, noteType: existing.note_type,
      previewDataJson: existing.preview_data_json, generationPrompt: existing.generation_prompt,
    };
    try { updateTemplate(db, args.templateId as string, updateReq); }
    catch (error) {
      const text = storeErrorText(error);
      return TemplateDesignerExecutor.fail(call, ctx, text.includes('optimistic_lock_failed')
        ? '模板已被其他操作更新。请重新用 template_get 获取最新版本后重试'
        : `更新模板失败: ${text}。请检查数据格式`, started);
    }
    // The L16 facade marks builtin user_modified itself (template-service.ts update).
    if (existing.is_built_in && db.kind === 'db') {
      try { db.db.markTemplateUserModified(args.templateId as string); }
      catch (error) {
        ctx.warn(`[TemplateDesignerExecutor] mark user_modified failed: id=${args.templateId}, err=${errorText(error)}`);
      }
    }
    let after: CustomAnkiTemplate | null = null;
    // template_executor.rs:1167-1170 `.ok().flatten()`: a failed re-read falls
    // back to `before` without logging; the update itself already succeeded.
    try { after = getTemplate(db, args.templateId as string); }
    catch { after = null; }
    const afterTemplate = after === null ? structuredClone(before) : {
      name: after.name, frontTemplate: after.front_template, backTemplate: after.back_template,
      cssStyle: after.css_style, fields: after.fields, noteType: after.note_type,
      previewDataJson: after.preview_data_json, generationPrompt: after.generation_prompt,
      version: after.version,
    };
    const name = after?.name ?? existing.name;
    const version = after?.version ?? null;
    const fields = after?.fields ?? existing.fields;
    const noteType = after?.note_type ?? existing.note_type;
    const display = {
      _templateVisual: true, _templateDiff: true, updated: true, templateId: args.templateId,
      name, version, fields, noteType, before, after: afterTemplate,
    };
    const model = { updated: true, templateId: args.templateId, name, version, fields, noteType, _visualRendered: true };
    return TemplateDesignerExecutor.succeedVisual(call, ctx, display, model, started);
  }

  private fork(call: ToolCall, ctx: ToolExecutionContext, started: number): ToolResultInfo {
    let args: ParsedTemplateArgs;
    try { args = parseTemplateArgs('template_fork', call.arguments); }
    catch (error) { return TemplateDesignerExecutor.argFailure(call, ctx, '参数错误: ', error, '。请提供 sourceTemplateId', started); }
    let db: TemplateStore;
    try { db = TemplateDesignerExecutor.getDb(ctx); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
    let source: CustomAnkiTemplate | null;
    try { source = getTemplate(db, args.sourceTemplateId as string); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `查询源模板失败: ${storeErrorText(error)}`, started); }
    if (!source) return TemplateDesignerExecutor.fail(call, ctx, `源模板 '${args.sourceTemplateId}' 不存在。请使用 template_list 查看可用模板`, started);
    const req = forkCreateRequest(source, {
      sourceTemplateId: args.sourceTemplateId as string,
      name: args.name ?? null, description: args.description ?? null, setActive: args.setActive ?? true,
    });
    let newId: string;
    try { newId = createTemplate(db, req); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `分叉模板失败: ${storeErrorText(error)}。请稍后重试`, started); }
    const isActive = req.is_active ?? true;
    const display = {
      _templateVisual: true, forked: true, templateId: newId, sourceTemplateId: args.sourceTemplateId,
      name: req.name, noteType: req.note_type, fields: req.fields, frontTemplate: req.front_template,
      backTemplate: req.back_template, cssStyle: req.css_style, previewDataJson: req.preview_data_json,
      isActive,
    };
    const model = {
      forked: true, templateId: newId, sourceTemplateId: args.sourceTemplateId, name: req.name,
      noteType: req.note_type, fields: req.fields, isActive, _visualRendered: true,
    };
    return TemplateDesignerExecutor.succeedVisual(call, ctx, display, model, started);
  }

  private preview(call: ToolCall, ctx: ToolExecutionContext, started: number): ToolResultInfo {
    let args: ParsedTemplateArgs;
    try { args = parseTemplateArgs('template_preview', call.arguments); }
    catch (error) { return TemplateDesignerExecutor.argFailure(call, ctx, '参数错误: ', error, '。请提供 templateId 或 template', started); }
    let front: string, back: string, css: string, fields: string[], usedId: string | null, previewData: string | null;
    if (args.templateId != null) {
      let db: TemplateStore;
      try { db = TemplateDesignerExecutor.getDb(ctx); }
      catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
      let template: CustomAnkiTemplate | null;
      try { template = getTemplate(db, args.templateId); }
      catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `查询模板失败: ${storeErrorText(error)}`, started); }
      if (!template) return TemplateDesignerExecutor.fail(call, ctx, `模板 '${args.templateId}' 不存在。请使用 template_list 查看可用模板`, started);
      front = template.front_template; back = template.back_template; css = template.css_style;
      fields = template.fields; usedId = args.templateId; previewData = template.preview_data_json;
    } else if (args.template != null) {
      let draft: Record<string, unknown>;
      try { draft = normalizeTemplateValue(args.template); }
      catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
      const pick = (camel: string, snake: string): string => {
        const value = Object.hasOwn(draft, camel) ? draft[camel] : draft[snake];
        return typeof value === 'string' ? value : '';
      };
      front = pick('frontTemplate', 'front_template');
      back = pick('backTemplate', 'back_template');
      css = pick('cssStyle', 'css_style');
      try { fields = extractFields(draft) ?? []; }
      catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
      const previewValue = Object.hasOwn(draft, 'previewDataJson') ? draft.previewDataJson : draft.preview_data_json;
      previewData = typeof previewValue === 'string' ? previewValue : null;
      if (previewValue != null && typeof previewValue !== 'string') {
        return TemplateDesignerExecutor.fail(call, ctx,
          `字段 'previewDataJson' 必须是字符串，实际收到 ${valueTypeLabel(previewValue)}。请传入字符串值`, started);
      }
      usedId = null;
    } else {
      return TemplateDesignerExecutor.fail(call, ctx, '请提供 templateId 或 template 草稿用于预览', started);
    }
    const display = {
      _templateVisual: true, frontTemplate: front, backTemplate: back, cssStyle: css, fields,
      usedTemplateId: usedId, sampleData: args.sampleData ?? null, previewDataJson: previewData,
    };
    const model = { previewRendered: true, usedTemplateId: usedId, fields, _visualRendered: true };
    return TemplateDesignerExecutor.succeedVisual(call, ctx, display, model, started);
  }

  private remove(call: ToolCall, ctx: ToolExecutionContext, started: number): ToolResultInfo {
    let args: ParsedTemplateArgs;
    try { args = parseTemplateArgs('template_delete', call.arguments); }
    catch (error) {
      return TemplateDesignerExecutor.argFailure(call, ctx, '参数解析失败: ', error, '。请提供 templateId (string) 参数。', started);
    }
    let db: TemplateStore;
    try { db = TemplateDesignerExecutor.getDb(ctx); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
    let template: CustomAnkiTemplate | null;
    try { template = getTemplate(db, args.templateId as string); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `查询模板失败: ${storeErrorText(error)}`, started); }
    if (!template) {
      return TemplateDesignerExecutor.fail(call, ctx,
        `模板不存在: ${args.templateId}。请使用 builtin-template_list 查看可用模板。`, started);
    }
    const templateName = template.name;
    const templateId = args.templateId as string;
    let referencing: number;
    if (db.kind === 'service') {
      // The L16 facade counts referencing cards, soft-deletes builtin rows
      // (user_deleted tombstone) or physically deletes custom rows in one call.
      // The branch and its failure prefix follow this executor's pre-read row.
      try { referencing = db.templates.delete(templateId).referencingCards; }
      catch (error) {
        return TemplateDesignerExecutor.fail(call, ctx,
          `${template.is_built_in ? '停用内置模板失败' : '删除模板失败'}: ${storeErrorText(error)}`, started);
      }
    } else {
      try { referencing = db.db.countAnkiCardsReferencingTemplate(templateId); }
      catch (error) {
        ctx.warn(`[TemplateDesignerExecutor] count referencing cards failed: id=${templateId}, err=${errorText(error)}`);
        referencing = 0;
      }
      if (template.is_built_in) {
        try { db.db.softDeleteBuiltinTemplate(templateId); }
        catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `停用内置模板失败: ${errorText(error)}`, started); }
      } else {
        try { db.db.deleteCustomTemplate(templateId); }
        catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `删除模板失败: ${errorText(error)}`, started); }
      }
    }
    if (template.is_built_in) {
      ctx.info?.(`[TemplateDesignerExecutor] Soft-deleted builtin template: id=${templateId}, name=${templateName}`);
      return TemplateDesignerExecutor.succeed(call, ctx, {
        success: true, deleted: false, deactivated: true, isBuiltIn: true, templateId, templateName,
        referencingCards: referencing,
        message: `内置模板「${templateName}」已停用（内置模板不可物理删除，已有 ${referencing} 张卡片引用不受影响；后续版本升级不会重新启用它）。`,
      }, started);
    }
    ctx.info?.(`[TemplateDesignerExecutor] Deleted template: id=${templateId}, name=${templateName}`);
    return TemplateDesignerExecutor.succeed(call, ctx, {
      success: true, deleted: true, deactivated: false, isBuiltIn: false, templateId, templateName,
      referencingCards: referencing, message: `模板「${templateName}」已成功删除。`,
    }, started);
  }

  private setDefault(call: ToolCall, ctx: ToolExecutionContext, started: number): ToolResultInfo {
    let args: ParsedTemplateArgs;
    try { args = parseTemplateArgs('template_set_default', call.arguments); }
    catch (error) {
      return TemplateDesignerExecutor.argFailure(call, ctx, '参数解析失败: ', error, '。请提供 templateId (string) 参数。', started);
    }
    let db: TemplateStore;
    try { db = TemplateDesignerExecutor.getDb(ctx); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, errorText(error), started); }
    let template: CustomAnkiTemplate | null;
    try { template = getTemplate(db, args.templateId as string); }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `查询模板失败: ${storeErrorText(error)}`, started); }
    if (!template) return TemplateDesignerExecutor.fail(call, ctx, `模板 '${args.templateId}' 不存在。请使用 template_list 查看可用模板`, started);
    if (!template.is_active) {
      return TemplateDesignerExecutor.fail(call, ctx, `模板「${template.name}」当前为停用状态，不能设为默认模板。请先将其激活`, started);
    }
    try {
      if (db.kind === 'db') db.db.setDefaultTemplate(args.templateId as string);
      else db.settings.saveSetting(DEFAULT_TEMPLATE_SETTING_KEY, args.templateId as string);
    }
    catch (error) { return TemplateDesignerExecutor.fail(call, ctx, `设置默认模板失败: ${storeErrorText(error)}`, started); }
    ctx.info?.(`[TemplateDesignerExecutor] Set default template: id=${args.templateId}, name=${template.name}`);
    return TemplateDesignerExecutor.succeed(call, ctx, {
      success: true, templateId: args.templateId, templateName: template.name,
      message: `已将「${template.name}」设为默认制卡模板。`,
    }, started);
  }

  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.info?.(`[TemplateDesignerExecutor] execute: tool_name=${call.name}, tool_call_id=${call.id}, session_id=${ctx.sessionId}, message_id=${ctx.messageId}`);
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    switch (stripToolNamespace(call.name)) {
      case 'template_list': return this.list(call, ctx, started);
      case 'template_get': return this.get(call, ctx, started);
      case 'template_validate': return this.validate(call, ctx, started);
      case 'template_create': return this.create(call, ctx, started);
      case 'template_update': return this.update(call, ctx, started);
      case 'template_fork': return this.fork(call, ctx, started);
      case 'template_preview': return this.preview(call, ctx, started);
      case 'template_delete': return this.remove(call, ctx, started);
      case 'template_set_default': return this.setDefault(call, ctx, started);
      default: throw new Error(`Unsupported template designer tool: ${stripToolNamespace(call.name)}`);
    }
  }
}
