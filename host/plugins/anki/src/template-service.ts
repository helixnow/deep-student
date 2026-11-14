/** Shared production template CRUD, extracted from plugin-handlers-templates.ts. */
import type { AnkiTemplateService } from '../api.ts';
import type { CreateTemplateRequest, FieldExtractionRule__De } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { JsonReader, stringifyJsonValue } from '../../../platform/util/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { AnkiLogger } from './logger.ts';
import {
  buildTemplateRequestForUpdate, decodeFieldExtractionRules, decodeTemplateRow, SerdeError, validateTemplateRequest,
  type TemplateRow,
} from './templates.ts';
import { nowRfc3339 } from './time.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import { dbFailure, messages, validationFailure, valueOptionalString, valueString } from './plugin-runtime.ts';
import {
  countCardsReferencingTemplate, createTemplateWithId, deleteTemplate, getTemplateById, getTemplateVersion,
  insertTemplate, listTemplates, markTemplateUserModified, softDeleteBuiltinTemplate, updateTemplate,
} from '../repository/templates.ts';

type Rules = Record<string, FieldExtractionRule__De>;

/** `serde_json::from_str::<Vec<String>>(..).ok()` / `from_value(..).ok()`. */
function stringVec(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

function parsedOk<T>(text: unknown, decode: (value: unknown) => T | null): T | null {
  if (typeof text !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return decode(value);
}

function rulesOk(value: unknown): Rules | null {
  try {
    return decodeFieldExtractionRules(value);
  } catch (error) {
    if (error instanceof SerdeError) return null;
    throw error;
  }
}

/** `chatanki_executor.rs:11361-11417` normalize_template_fields + ensure_field_extraction_rules. */
function normalizedFieldsAndRules(fields: string[], rules: Rules): [string[], Rules] {
  const normalized = fields.length === 0 ? ['front', 'back', 'tags'] : [...fields];
  const filled: Rules = { ...rules };
  for (const field of normalized) {
    if (Object.hasOwn(filled, field)) continue;
    const lower = field.toLowerCase();
    Object.defineProperty(filled, field, {
      enumerable: true, writable: true, configurable: true,
      value: {
        field_type: lower === 'tags' ? 'Array' : 'Text',
        is_required: lower === 'front' || lower === 'back',
        default_value: lower === 'tags' ? '[]' : null,
        validation_pattern: null,
        description: field,
      },
    });
  }
  return [normalized, filled];
}

/** `chatanki_executor.rs:11745-11747`: bundled `builtin-templates.json` as `Vec<Value>`. */
function readBundledBuiltinTemplates(): unknown[] {
  try {
    const reader = new JsonReader(ankiLocalRuntime().readBundledText('builtin-templates.json'));
    reader.beginArray();
    const values: unknown[] = [];
    while (reader.nextItem()) values.push(JSON.parse(stringifyJsonValue(reader.readValue())) as unknown);
    reader.end();
    return values;
  } catch (error) {
    throw new Error(`Parse builtin templates failed: ${messages(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `if let Ok(Some(_)) = db.get_custom_template_by_id(..)`: read errors fall through to the insert. */
function templateReadable(db: () => SqlExecutor, templateId: string, now: () => Date, logger: AnkiLogger): boolean {
  try {
    const row = getTemplateById(db(), templateId);
    if (row === undefined) return false;
    decodeTemplateRow(row, now, logger);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

/** `db.create_custom_template_with_id(..).is_ok()`: failures are discarded without a log. */
function insertedWithId(db: () => SqlExecutor, templateId: string, request: CreateTemplateRequest): boolean {
  try {
    createTemplateWithId(db(), templateId, request, nowRfc3339());
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export function createAnkiTemplates(options: {
  db: () => SqlExecutor;
  now: () => Date;
  logger: AnkiLogger;
}): AnkiTemplateService {
  const { db, now, logger } = options;
  return {
    list() {
      let rows: TemplateRow[];
      try {
        rows = listTemplates(db());
      } catch (error) {
        dbFailure('获取模板列表失败', error);
      }
      return rows.map((row) => decodeTemplateRow(row, now, logger));
    },

    get(templateId) {
      let row: TemplateRow | undefined;
      try {
        row = getTemplateById(db(), templateId);
      } catch (error) {
        dbFailure('获取模板失败', error);
      }
      return row === undefined ? null : decodeTemplateRow(row, now, logger);
    },

    create(request) {
      const invalid = validateTemplateRequest(request, logger);
      if (invalid !== null) validationFailure(invalid);
      const templateId = globalThis.crypto.randomUUID();
      try {
        insertTemplate(db(), templateId, request, nowRfc3339());
      } catch (error) {
        dbFailure('创建模板失败', error);
      }
      return templateId;
    },

    update(templateId, request) {
      let row: TemplateRow | undefined;
      try {
        row = getTemplateById(db(), templateId);
      } catch (error) {
        dbFailure('查询模板失败', error);
      }
      if (row === undefined) validationFailure('模板不存在');
      const existing = decodeTemplateRow(row, now, logger);
      if (request.expected_version === undefined || request.expected_version === null) {
        validationFailure('模板版本缺失，请刷新后重试');
      }
      if (request.expected_version !== existing.version) {
        validationFailure('模板已被更新，请刷新后重试');
      }
      const merged = buildTemplateRequestForUpdate(existing, request);
      const invalid = validateTemplateRequest(merged, logger);
      if (invalid !== null) validationFailure(invalid);
      if (request.version !== undefined && request.version !== null && request.version === existing.version) {
        request = { ...request, version: null };
      }
      let updated: boolean;
      try {
        updated = updateTemplate(db(), templateId, request, existing.version, nowRfc3339());
      } catch (error) {
        dbFailure('更新模板失败', error);
      }
      if (!updated) validationFailure('模板已被更新，请刷新后重试');
      if (existing.is_built_in) {
        try {
          markTemplateUserModified(db(), templateId);
        } catch (error) {
          logger.warn(`标记内置模板 user_modified 失败: ${templateId} (${messages(error)})，内置模板升级导入可能覆盖此次修改`);
        }
      }
      return null;
    },

    delete(templateId) {
      let row: TemplateRow | undefined;
      try {
        row = getTemplateById(db(), templateId);
      } catch (error) {
        dbFailure('查询模板失败', error);
      }
      if (row === undefined) validationFailure('模板不存在');
      const template = decodeTemplateRow(row, now, logger);
      let referencingCards: number;
      try {
        referencingCards = countCardsReferencingTemplate(db(), templateId);
      } catch (error) {
        dbFailure('统计模板引用卡片失败', error);
      }
      if (template.is_built_in) {
        try {
          softDeleteBuiltinTemplate(db(), templateId, nowRfc3339());
        } catch (error) {
          dbFailure('停用内置模板失败', error);
        }
        return {
          deleted: false, deactivated: true, isBuiltIn: true, referencingCards,
          message: `内置模板「${template.name}」已停用（内置模板不可物理删除，已有 ${referencingCards} 张卡片引用不受影响）`,
        };
      }
      try {
        deleteTemplate(db(), templateId);
      } catch (error) {
        dbFailure('删除模板失败', error);
      }
      if (referencingCards > 0) {
        logger.warn(`模板 '${template.name}' 已删除，但仍有 ${referencingCards} 张卡片引用它（template_id 绑定失效）`);
      }
      return {
        deleted: true, deactivated: false, isBuiltIn: false, referencingCards,
        message: `模板「${template.name}」已删除`,
      };
    },

    importBuiltinTemplatesIfEmpty() {
      let imported = 0;
      for (const value of readBundledBuiltinTemplates()) {
        const object = isRecord(value) ? value : {};
        const rawId = object.id;
        const templateId = rustTrim(typeof rawId === 'string' ? rawId : '');
        if (templateId === '') continue;
        if (templateReadable(db, templateId, now, logger)) continue;
        const fields = parsedOk(object.fields_json, stringVec) ?? stringVec(object.fields) ?? [];
        const rules = parsedOk(object.field_extraction_rules_json, rulesOk) ?? rulesOk(object.field_extraction_rules) ?? {};
        const [normalizedFields, normalizedRules] = normalizedFieldsAndRules(fields, rules);
        const request: CreateTemplateRequest = {
          name: valueString(object, 'name', '未命名模板'),
          description: valueString(object, 'description', ''),
          author: valueOptionalString(object, 'author'),
          version: valueOptionalString(object, 'version'),
          preview_front: valueString(object, 'preview_front', ''),
          preview_back: valueString(object, 'preview_back', ''),
          note_type: valueString(object, 'note_type', 'Basic'),
          fields: normalizedFields,
          generation_prompt: valueString(object, 'generation_prompt', ''),
          front_template: valueString(object, 'front_template', ''),
          back_template: valueString(object, 'back_template', ''),
          css_style: valueString(object, 'css_style', ''),
          field_extraction_rules: normalizedRules,
          preview_data_json: valueOptionalString(object, 'preview_data_json'),
          is_active: true,
          is_built_in: true,
        };
        if (insertedWithId(db, templateId, request)) imported += 1;
      }
      return imported;
    },

    listAll() {
      return listTemplates(db()).map((row) => decodeTemplateRow(row, now, logger));
    },

    updateIfVersion(templateId, request) {
      const conn = db();
      const updatedAt = nowRfc3339();
      const currentVersion = request.version === undefined || request.version === null
        ? getTemplateVersion(conn, templateId)
        : null;
      if (!updateTemplate(conn, templateId, request, currentVersion, updatedAt)) {
        throw new Error('optimistic_lock_failed');
      }
    },

    markUserModified(templateId) {
      markTemplateUserModified(db(), templateId);
    },

    countReferencingCards(templateId) {
      return countCardsReferencingTemplate(db(), templateId);
    },

    softDeleteBuiltin(templateId) {
      softDeleteBuiltinTemplate(db(), templateId, nowRfc3339());
    },

    deleteCustom(templateId) {
      deleteTemplate(db(), templateId);
    },
  };
}
