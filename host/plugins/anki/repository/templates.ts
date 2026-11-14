/**
 * `custom_anki_templates` 仓储（`dstu-storage/src/database/mod.rs:2440-3020`；`settings` 表归 F4，见 `src/settings-owner.ts`）。
 * SQL 只出现在本目录。
 */
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import type { CreateTemplateRequest, UpdateTemplateRequest } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { rs, RustShapeError, toRustJson, type RustSchema } from '../../../platform/serde-compat/index.ts';
import { TEMPLATE_COLUMNS, incrementVersion, serializeFieldExtractionRule, type TemplateRow } from '../src/templates.ts';

const LIST = defineQuery<void, TemplateRow>(
  `SELECT ${TEMPLATE_COLUMNS} FROM custom_anki_templates ORDER BY created_at DESC, id ASC`,
  { name: 'anki.templates.list' },
);

const BY_ID = defineQuery<[string], TemplateRow>(
  `SELECT ${TEMPLATE_COLUMNS} FROM custom_anki_templates WHERE id = ?1`,
  { name: 'anki.templates.byId' },
);

const opt = (schema: RustSchema) => rs.field(rs.option(schema), { skipIf: 'none' });

/** `dstu-core/src/models.rs:1542` `FieldExtractionRule` (+ :1516 `ValidationRule`, :1527 `TransformRule`, :1535 `ObjectSchema`). */
const FIELD_EXTRACTION_RULE: RustSchema = rs.lazy('FieldExtractionRule', () => {
  const objectSchema = rs.struct({ properties: rs.hashMap(FIELD_EXTRACTION_RULE), required: rs.option(rs.vec(rs.string)) });
  return rs.struct({
    field_type: rs.enum({ Text: null, Array: null, Number: null, Boolean: null, Date: null, RichText: null, Formula: null }),
    is_required: rs.bool,
    default_value: rs.option(rs.string),
    validation_pattern: rs.option(rs.string),
    description: rs.string,
    validation: opt(rs.struct({ pattern: rs.option(rs.string), min: rs.option(rs.f64), max: rs.option(rs.f64),
      enum_values: rs.option(rs.vec(rs.value())), custom: rs.option(rs.string), error_message: rs.option(rs.string) })),
    transform: opt(rs.struct({ transform_type: rs.string, format: rs.option(rs.string), custom_function: rs.option(rs.string) })),
    schema: opt(objectSchema),
    item_schema: opt(objectSchema),
    display_format: opt(rs.string),
    ai_hint: opt(rs.string),
    max_length: opt(rs.u32),
    min_length: opt(rs.u32),
    allowed_values: opt(rs.vec(rs.value())),
    depends_on: opt(rs.string),
    compute_function: opt(rs.string),
  });
});

/**
 * `serde_json::to_string(&HashMap<String, FieldExtractionRule>)`. A rule Rust could not have
 * deserialized keeps the shallow struct re-serialization instead of failing the write.
 */
function fieldExtractionRulesJson(rules: CreateTemplateRequest['field_extraction_rules']): string {
  const entries = Object.entries(rules).map(([key, rule]) => {
    let json: string;
    try {
      json = toRustJson(rule, FIELD_EXTRACTION_RULE);
    } catch (error) {
      if (!(error instanceof RustShapeError)) throw error;
      json = JSON.stringify(serializeFieldExtractionRule(rule));
    }
    return `${JSON.stringify(key)}:${json}`;
  });
  return `{${entries.join(',')}}`;
}

export function listTemplates(db: SqlExecutor): TemplateRow[] {
  return db.all(LIST);
}

export function getTemplateById(db: SqlExecutor, templateId: string): TemplateRow | undefined {
  return db.get(BY_ID, [templateId]);
}

/** `database/mod.rs:2728-2736`：`row.get::<_, String>(0)` 失败或无行时 Rust 回退 `1.0.0`。 */
export function getTemplateVersion(db: SqlExecutor, templateId: string): string {
  let version: unknown;
  try {
    version = db.pluck('SELECT version FROM custom_anki_templates WHERE id = ?1', [templateId]);
  } catch (error) {
    if (error instanceof Error) return '1.0.0';
    throw error;
  }
  return typeof version === 'string' ? version : '1.0.0';
}

/** `create_custom_template` / `create_custom_template_with_id`：19 列插入。 */
export function insertTemplate(db: SqlExecutor, templateId: string, request: CreateTemplateRequest, now: string): void {
  db.run(
    `INSERT INTO custom_anki_templates
     (id, name, description, author, version, preview_front, preview_back, note_type,
      fields_json, generation_prompt, front_template, back_template, css_style,
      field_extraction_rules_json, created_at, updated_at, is_active, is_built_in, preview_data_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
    [
      templateId,
      request.name,
      request.description,
      request.author ?? null,
      request.version ?? '1.0.0',
      request.preview_front,
      request.preview_back,
      request.note_type,
      JSON.stringify(request.fields),
      request.generation_prompt,
      request.front_template,
      request.back_template,
      request.css_style,
      fieldExtractionRulesJson(request.field_extraction_rules),
      now,
      now,
      request.is_active ?? true ? 1 : 0,
      request.is_built_in ?? false ? 1 : 0,
      request.preview_data_json ?? null,
    ],
  );
}

/** `create_custom_template_with_id`（内置模板导入用指定 ID）。 */
export const createTemplateWithId = insertTemplate;

/**
 * `update_custom_template`：动态 UPDATE + 可选乐观锁。
 * 返回 false 表示 `expected_version` 存在但未命中（`optimistic_lock_failed`）。
 */
export function updateTemplate(
  db: SqlExecutor,
  templateId: string,
  request: UpdateTemplateRequest,
  existingVersion: string | null,
  now: string,
): boolean {
  const parts: string[] = [];
  const params: (string | number | null)[] = [];

  if (request.version !== undefined && request.version !== null) {
    parts.push('version = ?');
    params.push(request.version);
  } else {
    const current = existingVersion ?? '1.0.0';
    parts.push('version = ?');
    params.push(incrementVersion(current));
  }
  const optional = [
    ['name', request.name],
    ['description', request.description],
    ['author', request.author],
    ['preview_front', request.preview_front],
    ['preview_back', request.preview_back],
    ['note_type', request.note_type],
    ['generation_prompt', request.generation_prompt],
    ['front_template', request.front_template],
    ['back_template', request.back_template],
    ['css_style', request.css_style],
    ['preview_data_json', request.preview_data_json],
  ] as const;
  for (const [column, value] of optional) {
    if (value === undefined || value === null) continue;
    parts.push(`${column} = ?`);
    params.push(value);
  }
  if (request.fields !== undefined && request.fields !== null) {
    parts.push('fields_json = ?');
    params.push(JSON.stringify(request.fields));
  }
  if (request.field_extraction_rules !== undefined && request.field_extraction_rules !== null) {
    parts.push('field_extraction_rules_json = ?');
    params.push(fieldExtractionRulesJson(request.field_extraction_rules));
  }
  if (request.is_active !== undefined && request.is_active !== null) {
    parts.push('is_active = ?');
    params.push(request.is_active ? 1 : 0);
  }
  if (request.is_built_in !== undefined && request.is_built_in !== null) {
    parts.push('is_built_in = ?');
    params.push(request.is_built_in ? 1 : 0);
  }
  parts.push('updated_at = ?');
  params.push(now);

  let where = 'id = ?';
  const whereParams: (string | number)[] = [templateId];
  if (request.expected_version !== undefined && request.expected_version !== null) {
    where = 'id = ? AND version = ?';
    whereParams.push(request.expected_version);
  }
  const result = db.run(
    `UPDATE custom_anki_templates SET ${parts.join(', ')} WHERE ${where}`,
    [...params, ...whereParams],
  );
  return !(request.expected_version !== undefined && request.expected_version !== null && result.changes === 0);
}

/** `replace_custom_template_content`：保持 ID 与 is_built_in 的原地替换。 */
export function replaceTemplateContent(db: SqlExecutor, templateId: string, request: CreateTemplateRequest, now: string): number {
  const result = db.run(
    `UPDATE custom_anki_templates SET
        name = ?2, description = ?3, author = ?4, version = ?5,
        preview_front = ?6, preview_back = ?7, note_type = ?8,
        fields_json = ?9, generation_prompt = ?10,
        front_template = ?11, back_template = ?12, css_style = ?13,
        field_extraction_rules_json = ?14, preview_data_json = ?15,
        is_active = ?16, updated_at = ?17
     WHERE id = ?1`,
    [
      templateId,
      request.name,
      request.description,
      request.author ?? null,
      request.version ?? '1.0.0',
      request.preview_front,
      request.preview_back,
      request.note_type,
      JSON.stringify(request.fields),
      request.generation_prompt,
      request.front_template,
      request.back_template,
      request.css_style,
      fieldExtractionRulesJson(request.field_extraction_rules),
      request.preview_data_json ?? null,
      request.is_active ?? true ? 1 : 0,
      now,
    ],
  );
  if (result.changes === 0) throw new Error(`template_not_found: ${templateId}`);
  return result.changes;
}

export function deleteTemplate(db: SqlExecutor, templateId: string): void {
  db.run('DELETE FROM custom_anki_templates WHERE id = ?1', [templateId]);
}

export function countCardsReferencingTemplate(db: SqlExecutor, templateId: string): number {
  try {
    return db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE template_id = ?1 AND deleted_at IS NULL', [templateId]) ?? 0;
  } catch {
    return db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE template_id = ?1', [templateId]) ?? 0;
  }
}

function ensureTemplateUserStateColumns(db: SqlExecutor): void {
  for (const ddl of [
    'ALTER TABLE custom_anki_templates ADD COLUMN user_modified INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE custom_anki_templates ADD COLUMN user_deleted INTEGER NOT NULL DEFAULT 0',
  ]) {
    try {
      db.run(ddl);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column name')) throw error;
    }
  }
}

export function getTemplateUserStates(db: SqlExecutor): Map<string, { userModified: boolean; userDeleted: boolean }> {
  ensureTemplateUserStateColumns(db);
  const rows = db.all<{ id: string; user_modified: number; user_deleted: number }>(
    'SELECT id, user_modified, user_deleted FROM custom_anki_templates',
  );
  return new Map(rows.map((row) => [row.id, { userModified: row.user_modified !== 0, userDeleted: row.user_deleted !== 0 }]));
}

/** 对非内置模板是 no-op。 */
export function markTemplateUserModified(db: SqlExecutor, templateId: string): void {
  ensureTemplateUserStateColumns(db);
  db.run('UPDATE custom_anki_templates SET user_modified = 1 WHERE id = ?1 AND is_built_in = 1', [templateId]);
}

/** 软删除内置模板；未命中抛 `builtin_template_not_found: <id>`。 */
export function softDeleteBuiltinTemplate(db: SqlExecutor, templateId: string, now: string): void {
  ensureTemplateUserStateColumns(db);
  const result = db.run(
    `UPDATE custom_anki_templates
     SET user_deleted = 1, is_active = 0, updated_at = ?2
     WHERE id = ?1 AND is_built_in = 1`,
    [templateId, now],
  );
  if (result.changes === 0) throw new Error(`builtin_template_not_found: ${templateId}`);
}
