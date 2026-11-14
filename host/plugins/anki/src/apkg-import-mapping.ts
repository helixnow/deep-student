/**
 * Anki 卡片行 → `ParsedCard` 映射与单卡限额校验。
 */
import {
  APKG_ERROR_LIMIT_EXCEEDED,
  MAX_FIELDS_PER_MODEL,
  MAX_FIELD_VALUE_BYTES,
  MAX_RAW_TAG_BYTES,
  MAX_TAGS_PER_CARD,
  MAX_TAG_BYTES,
  MAX_TEMPLATE_ID_BYTES,
  UNTRUSTED_IMPORT_PROTOCOL_FIELDS,
  type ModelDefinition,
  type ParsedCard,
  byteLen,
  splitWhitespace,
  eqIgnoreAsciiCase,
  limitError,
} from './apkg-import-types.ts';
import type { LegacyCollectionCardRow } from '../repository/apkg-import.ts';
import type { AnkiLogger } from './logger.ts';
import { collectCardMediaPaths } from './apkg-import-media.ts';

// ============================================================================
// 卡片字段映射
// ============================================================================

export function isUntrustedImportProtocolField(name: string): boolean {
  return UNTRUSTED_IMPORT_PROTOCOL_FIELDS.some((field) => eqIgnoreAsciiCase(field, name));
}

function isCoreCardField(modelType: number, name: string): boolean {
  return eqIgnoreAsciiCase(name, 'Front')
    || eqIgnoreAsciiCase(name, 'Back')
    || (modelType === 1 && eqIgnoreAsciiCase(name, 'Text'));
}

/** `map_card`：字段解析（Front/Back/Text 按 ord 大小写不敏感查找）、extras、标签、媒体。 */
export function mapCard(
  model: ModelDefinition,
  rawTags: string,
  rawFields: string,
  noteId: number,
  cardId: number,
  cardOrd: number,
  deckId: number,
  modelId: number,
  mediaPaths: ReadonlyMap<string, string>,
  logger: AnkiLogger,
): ParsedCard {
  const values = rawFields.split('\u001f');
  const oversized = values.find((value) => byteLen(value) > MAX_FIELD_VALUE_BYTES);
  if (oversized !== undefined) {
    throw limitError(
      `APKG field value exceeds the ${MAX_FIELD_VALUE_BYTES} byte limit (${byteLen(oversized)} bytes)`,
    );
  }

  const namedValue = (name: string): string | undefined => {
    for (let index = 0; index < values.length; index += 1) {
      const fieldName = model.fieldsByOrd.get(index);
      if (fieldName !== undefined && eqIgnoreAsciiCase(fieldName, name)) return values[index];
    }
    return undefined;
  };

  const front = namedValue('Front') ?? values[0] ?? '';
  const back = namedValue('Back') ?? values[1] ?? '';
  const text = model.modelType === 1 ? (namedValue('Text') ?? values[0] ?? '') : null;

  const extraFields: Record<string, string> = {};
  values.forEach((value, index) => {
    const baseName = model.fieldsByOrd.get(index) ?? `Field${index + 1}`;
    if (isCoreCardField(model.modelType, baseName)) return;
    // 剥离伪造协议字段：外部包不得携带本机可信凭证键。
    if (isUntrustedImportProtocolField(baseName)) {
      logger.warn(`导入包字段 '${baseName}' 与内部协议字段同名，已剥离（外部来源不可信）`);
      return;
    }
    let name = baseName;
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(extraFields, name)) {
      name = `${baseName} (${suffix})`;
      suffix += 1;
    }
    extraFields[name] = value;
  });

  for (const [key, value] of [
    ['AnkiNoteId', String(noteId)],
    ['AnkiCardId', String(cardId)],
    ['AnkiCardOrd', String(cardOrd)],
    ['AnkiDeckId', String(deckId)],
    ['AnkiModelId', String(modelId)],
    ['AnkiModelName', model.name],
  ] as const) {
    extraFields[key] = value;
  }

  const tags = splitWhitespace(rawTags);
  const images = collectCardMediaPaths(values, mediaPaths);

  return {
    front,
    back,
    text,
    tags,
    images,
    extraFields,
    templateId: model.templateId,
    ankiSched: null,
  };
}

// ============================================================================
// 材料化预算（`validate_and_estimate_card`）
// ============================================================================

export function validateAndEstimateCard(
  model: ModelDefinition,
  rawTags: string,
  rawFields: string,
): number {
  if (byteLen(rawTags) > MAX_RAW_TAG_BYTES) {
    throw limitError(`APKG tags exceed the ${MAX_RAW_TAG_BYTES} byte limit`);
  }

  let tagCount = 0;
  for (const tag of splitWhitespace(rawTags)) {
    tagCount += 1;
    if (tagCount > MAX_TAGS_PER_CARD) {
      throw limitError(`APKG card contains more than ${MAX_TAGS_PER_CARD} tags`);
    }
    if (byteLen(tag) > MAX_TAG_BYTES) {
      throw limitError(`APKG tag exceeds the ${MAX_TAG_BYTES} byte limit`);
    }
  }

  let fieldCount = 0;
  let firstFieldLen = 0;
  let namedTextLen: number | null = null;
  let extraKeyBytes = 0;
  let extraCount = 0;
  rawFields.split('\u001f').forEach((value, index) => {
    fieldCount += 1;
    if (fieldCount > MAX_FIELDS_PER_MODEL || fieldCount > model.fieldSlotCount) {
      throw limitError(
        `APKG note has ${fieldCount} fields but model ${model.name} allows at most ${model.fieldSlotCount}`,
      );
    }
    if (byteLen(value) > MAX_FIELD_VALUE_BYTES) {
      throw limitError(`APKG field value exceeds the ${MAX_FIELD_VALUE_BYTES} byte limit`);
    }
    if (index === 0) firstFieldLen = byteLen(value);
    const fieldName = model.fieldsByOrd.get(index);
    if (fieldName !== undefined && eqIgnoreAsciiCase(fieldName, 'Text')) {
      namedTextLen = byteLen(value);
    }
    if (fieldName === undefined || !isCoreCardField(model.modelType, fieldName)) {
      extraCount += 1;
      const keyBytes = fieldName === undefined ? 24 : byteLen(fieldName) + 16;
      extraKeyBytes += keyBytes;
    }
  });

  const estimatedExtraCount = extraCount + 6;
  let estimate = 1024;
  for (const component of [
    byteLen(rawFields),
    byteLen(rawTags),
    model.modelType === 1 ? (namedTextLen ?? firstFieldLen) : 0,
    byteLen(model.name),
    model.templateId === null ? 0 : byteLen(model.templateId),
    extraKeyBytes,
    fieldCount * 64,
    tagCount * 64,
    estimatedExtraCount * 128,
  ]) {
    estimate += component;
  }
  return estimate;
}

