/**
 * APKG 的 `models` / `decks` JSON 解析（legacy `collection.anki2` 内嵌配置）。
 */
import {
  APKG_ERROR_COLLECTION_INVALID,
  MAX_DECKS_JSON_BYTES,
  MAX_MODELS_JSON_BYTES,
  errorMessage,
  validationError,
  byteLen,
  compareUtf8,
  limitError,
  trimWhitespace,
  MAX_FIELDS_PER_MODEL,
  MAX_TEMPLATE_ID_BYTES,
  type AppErrorValue,
  type ModelDefinition,
  type TemplateImportCandidate,
} from './apkg-import-types.ts';

// ============================================================================
// legacy 模型 / 牌组 JSON（`parse_models` / `parse_deck_names`）
// ============================================================================

function readJsonObject(raw: string, kind: 'models' | 'decks'): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw validationError(
      APKG_ERROR_COLLECTION_INVALID,
      `APKG ${kind} metadata is invalid JSON: ${errorMessage(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw validationError(
      APKG_ERROR_COLLECTION_INVALID,
      `APKG ${kind} metadata is invalid JSON: invalid type: expected map`,
    );
  }
  return parsed as Record<string, unknown>;
}

function parseModelId(key: string, value: Record<string, unknown>): number {
  if (/^[+-]?\d+$/.test(key)) {
    const parsed = Number(key);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  const rawId = value.id;
  if (typeof rawId === 'number' && Number.isInteger(rawId)) return rawId;
  if (typeof rawId === 'string' && /^[+-]?\d+$/.test(rawId)) {
    const parsed = Number(rawId);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw validationError(APKG_ERROR_COLLECTION_INVALID, `APKG model has an invalid id: ${key}`);
}

interface RawModelField {
  name: string;
  ord: number | null;
}

interface RawModelTemplate {
  qfmt: string;
  afmt: string;
}

interface RawModel {
  name: string;
  modelType: number;
  fields: RawModelField[];
  templates: RawModelTemplate[];
  css: string;
  templateId: string | null;
  collapseClozeOrds: boolean | null;
}

function invalidModel(modelId: number, detail: string): AppErrorValue {
  return validationError(APKG_ERROR_COLLECTION_INVALID, `APKG model ${modelId} is invalid: ${detail}`);
}

function readRawModel(value: Record<string, unknown>, modelId: number): RawModel {
  const name = value.name ?? '';
  if (typeof name !== 'string') throw invalidModel(modelId, `invalid type for name: ${typeof name}`);
  const modelType = value.type ?? 0;
  if (typeof modelType !== 'number' || !Number.isInteger(modelType)) {
    throw invalidModel(modelId, `invalid type for type: ${typeof modelType}`);
  }
  const rawFields = value.flds ?? [];
  if (!Array.isArray(rawFields)) throw invalidModel(modelId, 'invalid type for flds: expected sequence');
  const fields: RawModelField[] = rawFields.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalidModel(modelId, 'invalid type for flds entry: expected map');
    }
    const field = entry as Record<string, unknown>;
    if (typeof field.name !== 'string') {
      throw invalidModel(modelId, 'field name is missing or not a string');
    }
    const ord = field.ord ?? null;
    if (ord !== null && (typeof ord !== 'number' || !Number.isInteger(ord))) {
      throw invalidModel(modelId, 'field ord is not an integer');
    }
    return { name: field.name, ord };
  });
  const rawTemplates = value.tmpls ?? [];
  if (!Array.isArray(rawTemplates)) throw invalidModel(modelId, 'invalid type for tmpls: expected sequence');
  const templates: RawModelTemplate[] = rawTemplates.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalidModel(modelId, 'invalid type for tmpls entry: expected map');
    }
    const template = entry as Record<string, unknown>;
    const qfmt = template.qfmt ?? '';
    const afmt = template.afmt ?? '';
    if (typeof qfmt !== 'string' || typeof afmt !== 'string') {
      throw invalidModel(modelId, 'template qfmt/afmt is not a string');
    }
    return { qfmt, afmt };
  });
  const css = value.css ?? '';
  if (typeof css !== 'string') throw invalidModel(modelId, 'invalid type for css: expected string');
  const rawTemplateId = value.deepStudentTemplateId ?? null;
  if (rawTemplateId !== null && typeof rawTemplateId !== 'string') {
    throw invalidModel(modelId, 'invalid type for deepStudentTemplateId: expected string');
  }
  const rawCollapse = value.deepStudentCollapseClozeOrds ?? null;
  if (rawCollapse !== null && typeof rawCollapse !== 'boolean') {
    throw invalidModel(modelId, 'invalid type for deepStudentCollapseClozeOrds: expected boolean');
  }
  return {
    name,
    modelType,
    fields,
    templates,
    css,
    templateId: rawTemplateId,
    collapseClozeOrds: rawCollapse,
  };
}

export function parseModels(raw: string): {
  models: Map<number, ModelDefinition>;
  templateCandidates: TemplateImportCandidate[];
} {
  const values = readJsonObject(raw, 'models');
  const keys = Object.keys(values);
  if (keys.length === 0) {
    throw validationError(APKG_ERROR_COLLECTION_INVALID, 'APKG models metadata is empty');
  }

  const models = new Map<number, ModelDefinition>();
  const templateCandidates: TemplateImportCandidate[] = [];
  const seenTemplateIds = new Set<string>();

  for (const key of keys) {
    const entry = values[key];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw validationError(
        APKG_ERROR_COLLECTION_INVALID,
        `APKG model has an invalid id: ${key}`,
      );
    }
    const value = entry as Record<string, unknown>;
    const modelId = parseModelId(key, value);
    const rawModel = readRawModel(value, modelId);

    if (rawModel.fields.length === 0 || rawModel.fields.length > MAX_FIELDS_PER_MODEL) {
      throw validationError(
        APKG_ERROR_COLLECTION_INVALID,
        `APKG model ${rawModel.name} has an invalid field count: ${rawModel.fields.length}`,
      );
    }

    const trimmedTemplateId = rawModel.templateId === null ? '' : trimWhitespace(rawModel.templateId);
    const templateId = trimmedTemplateId === '' ? null : trimmedTemplateId;
    if (templateId !== null && byteLen(templateId) > MAX_TEMPLATE_ID_BYTES) {
      throw limitError(
        `APKG model ${rawModel.name} template ID exceeds the ${MAX_TEMPLATE_ID_BYTES} byte limit`,
      );
    }

    const collapseClozeOrds = rawModel.modelType === 1
      && (rawModel.collapseClozeOrds ?? templateId !== null);

    const orderedFields = rawModel.fields.map((field, index) => ({
      ord: field.ord ?? index,
      index,
      name: field.name,
    }));
    if (orderedFields.some(({ ord, name }) => ord < 0 || ord >= MAX_FIELDS_PER_MODEL || trimWhitespace(name) === '')) {
      throw validationError(
        APKG_ERROR_COLLECTION_INVALID,
        `APKG model ${rawModel.name} has an invalid field definition`,
      );
    }
    orderedFields.sort((left, right) => left.ord - right.ord || left.index - right.index);
    const seenOrd = new Set<number>();
    for (const field of orderedFields) {
      if (seenOrd.has(field.ord)) {
        throw validationError(
          APKG_ERROR_COLLECTION_INVALID,
          `APKG model ${rawModel.name} has duplicate field ord values`,
        );
      }
      seenOrd.add(field.ord);
    }

    if (templateId !== null && !seenTemplateIds.has(templateId)) {
      seenTemplateIds.add(templateId);
      const firstTemplate = rawModel.templates[0];
      templateCandidates.push({
        templateId,
        name: rawModel.name,
        noteType: rawModel.modelType === 1 ? 'Cloze' : 'Basic',
        fields: orderedFields.map((field) => field.name),
        frontTemplate: firstTemplate?.qfmt ?? '',
        backTemplate: firstTemplate?.afmt ?? '',
        cssStyle: rawModel.css,
      });
    }

    const fieldsByOrd = new Map<number, string>();
    for (const field of orderedFields) fieldsByOrd.set(field.ord, field.name);
    models.set(modelId, {
      name: rawModel.name,
      modelType: rawModel.modelType,
      templateId,
      collapseClozeOrds,
      fieldSlotCount: (orderedFields[orderedFields.length - 1]?.ord ?? -1) + 1,
      fieldsByOrd,
    });
  }

  return { models, templateCandidates };
}

export function parseDeckNames(raw: string): string[] {
  const values = readJsonObject(raw, 'decks');
  const names: string[] = [];
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (typeof value !== 'object' || value === null) continue;
    const name = (value as Record<string, unknown>).name;
    if (typeof name === 'string' && trimWhitespace(name) !== '') names.push(name);
  }
  names.sort(compareUtf8);
  return dedupeSorted(names);
}

export function dedupeSorted(sorted: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of sorted) {
    if (out[out.length - 1] !== value) out.push(value);
  }
  return out;
}

