/**
 * AnkiConnect 同步明细（`dstu-anki/src/anki_connect_service.rs:145-1586`）：
 * 字段构建、模板模型预检、媒体上传、图像遮挡闭环，以及 canAddNotes/addNotes 分批推送。
 */
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { hostPath as path } from '../../../platform/util/path.ts';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { AnkiLogger } from './logger.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import {
  checkAnkiConnectAvailability,
  getModelFieldNames,
  getModelNames,
  invokeAnkiConnectAction,
  sanitizeSyncOptions,
  type AnkiConnectSyncOptions,
} from './anki-connect.ts';
import {
  buildCardFields,
  defaultOcclusionConfig,
  OCCLUSION_FIELD,
  OCCLUSION_TAG,
  parseOcclusionField,
  validateSpec,
  type OcclusionSpec,
} from './image-occlusion.ts';

/** `ANKI_CONNECT_MAX_MEDIA_BYTES`。 */
export const ANKI_CONNECT_MAX_MEDIA_BYTES = 32 * 1024 * 1024;

/** `RESERVED_IMPORT_METADATA_FIELDS`（`anki_connect_service.rs:160-175`）。 */
const RESERVED_IMPORT_METADATA_FIELDS = [
  'AnkiNoteId',
  'AnkiCardId',
  'AnkiCardOrd',
  'AnkiDeckId',
  'AnkiModelId',
  'AnkiModelName',
  'AnkiSchedType',
  'AnkiQueue',
  'AnkiDue',
  'AnkiIvl',
  'AnkiFactor',
  'AnkiReps',
  'AnkiLapses',
  'AnkiFsrs',
] as const;

/** `is_reserved_import_metadata_field`（ASCII 大小写不敏感）。 */
export function isReservedImportMetadataField(name: string): boolean {
  return RESERVED_IMPORT_METADATA_FIELDS.some(
    (reserved) => reserved.toLowerCase() === name.toLowerCase(),
  );
}

/** `is_internal_protocol_field`：`_` 前缀或导入元数据保留键。 */
export function isInternalProtocolField(name: string): boolean {
  return name.startsWith('_') || isReservedImportMetadataField(name);
}

/** `normalize_key`：仅保留字母数字。 */
export function normalizeFieldKey(key: string): string {
  return Array.from(key).filter((char) => /[\p{L}\p{N}]/u.test(char)).join('');
}

/** `build_basic_fields`。 */
export function buildBasicFields(card: AnkiCard, noteType: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (noteType === 'Basic' || noteType === 'Basic (and reversed card)' || noteType === 'Basic (optional reversed card)') {
    fields.Front = card.front;
    fields.Back = card.back;
    return fields;
  }
  if (noteType === 'Cloze') {
    const text = card.text;
    const clozeText = text !== null && text.trim() !== ''
      ? text
      : card.back === ''
        ? card.front
        : `${card.front}\n\n${card.back}`;
    fields.Text = clozeText;
    if (card.back.trim() !== '') fields.Extra = card.back;
    return fields;
  }
  fields.Front = card.front;
  fields.Back = card.back;
  return fields;
}

/**
 * `build_fields_with_model_names`：模型字段名 → 值。
 * `lower_extra` 的插入顺序与 Rust HashMap 不同，但同键覆盖语义一致。
 */
export function buildFieldsWithModelNames(
  card: AnkiCard,
  modelFieldNames: readonly string[],
  noteType: string,
): Record<string, string> {
  if (modelFieldNames.length === 0) return buildBasicFields(card, noteType);

  const lowerExtra = new Map<string, string>();
  for (const [key, value] of Object.entries(card.extra_fields)) {
    if (isInternalProtocolField(key)) continue;
    lowerExtra.set(key.toLowerCase(), value);
  }
  if (!lowerExtra.has('front')) lowerExtra.set('front', card.front);
  if (!lowerExtra.has('back')) lowerExtra.set('back', card.back);
  if (card.text !== null) lowerExtra.set('text', card.text);
  if (card.tags.length > 0) lowerExtra.set('tags', card.tags.join(' '));

  const normalizedExtra = new Map<string, string>();
  for (const [key, value] of lowerExtra) normalizedExtra.set(normalizeFieldKey(key), value);

  const fields: Record<string, string> = {};
  for (const fieldName of modelFieldNames) {
    const lower = fieldName.toLowerCase();
    const normalized = normalizeFieldKey(lower);
    let value: string;
    if (lower === 'front') {
      value = card.front;
    } else if (lower === 'back') {
      value = card.back;
    } else if (lower === 'extra') {
      value = lowerExtra.get('extra') ?? card.back;
    } else if (lower === 'text') {
      if (noteType.toLowerCase() === 'cloze') {
        const text = lowerExtra.get('text');
        value = text !== undefined ? text : card.back !== '' ? `${card.front}\n\n${card.back}` : card.front;
      } else {
        value = lowerExtra.get('text') ?? '';
      }
    } else if (normalized === 'backextra') {
      value = normalizedExtra.get(normalized) ?? card.back;
    } else if (lower === 'tags') {
      value = lowerExtra.get('tags') ?? '';
    } else {
      value = normalizedExtra.get(normalized) ?? lowerExtra.get(lower) ?? '';
    }
    fields[fieldName] = value;
  }
  return fields;
}

// ------------------------------------------------------------------ 模板模型

/** `template_model_name`：模型身份取自模板 id + version。 */
export function templateModelName(template: Pick<CustomAnkiTemplate, 'id' | 'version'>): string {
  return `Deep Student / ${template.id} / v${template.version}`;
}

/** `model_templates`。 */
export function modelTemplates(
  template: Pick<CustomAnkiTemplate, 'front_template' | 'back_template'>,
): Record<string, { Front: string; Back: string }> {
  return { 'Card 1': { Front: template.front_template, Back: template.back_template } };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left !== 'object') return false;
  const leftKeys = Object.keys(left as object).sort();
  const rightKeys = Object.keys(right as object).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
  return leftKeys.every((key) => deepEqual(
    (left as Record<string, unknown>)[key],
    (right as Record<string, unknown>)[key],
  ));
}

/** `model_matches_template`：字段顺序、卡面与 CSS 必须全部一致。 */
export function modelMatchesTemplate(
  template: Pick<CustomAnkiTemplate, 'fields' | 'front_template' | 'back_template' | 'css_style'>,
  fields: readonly string[],
  templates: unknown,
  styling: unknown,
): boolean {
  if (fields.length !== template.fields.length) return false;
  if (!fields.every((field, index) => field === template.fields[index])) return false;
  if (!deepEqual(templates, modelTemplates(template))) return false;
  const css = typeof styling === 'object' && styling !== null
    ? (styling as { css?: unknown }).css
    : undefined;
  return css === template.css_style;
}

/** `verify_existing_template_model`：已存在模型必须与本地模板完全一致。 */
export async function verifyExistingTemplateModel(
  modelName: string,
  template: Pick<CustomAnkiTemplate, 'fields' | 'front_template' | 'back_template' | 'css_style'>,
): Promise<void> {
  const fields = await getModelFieldNames(modelName);
  const params = { modelName };
  const templates = await invokeAnkiConnectAction('modelTemplates', params, 15, 0);
  const styling = await invokeAnkiConnectAction('modelStyling', params, 15, 0);
  if (!modelMatchesTemplate(template, fields, templates, styling)) {
    throw new Error(
      `Anki 模型「${modelName}」与本地模板的字段、卡面或样式不同。请使用新模板版本或复制为新模板后发送；已有 Anki 模型未被修改。`,
    );
  }
}

/** `create_model_from_template`（createModel 非幂等，不重试）。 */
export async function createModelFromTemplate(
  modelName: string,
  template: Pick<CustomAnkiTemplate, 'fields' | 'front_template' | 'back_template' | 'css_style'>,
): Promise<void> {
  if (modelName === '') throw new Error('Anki 模型名称不能为空');
  if (template.fields.length === 0) throw new Error('模板未配置字段，无法创建 Anki 模型');
  if (template.front_template.trim() === '' || template.back_template.trim() === '') {
    throw new Error('模板缺少正面/背面 HTML，无法创建 Anki 模型');
  }
  const isCloze = template.front_template.includes('{{cloze:') || template.back_template.includes('{{cloze:');
  await invokeAnkiConnectAction('createModel', {
    modelName,
    inOrderFields: template.fields,
    css: template.css_style,
    isCloze,
    cardTemplates: [{
      Name: 'Card 1',
      Front: template.front_template,
      Back: template.back_template,
    }],
  }, 15, 0);
}

// ------------------------------------------------------------------ 媒体

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'opus', 'aac', '3gp', 'spx']);

/** `is_audio_media_filename`。 */
export function isAudioMediaFilename(name: string): boolean {
  const ext = path.extname(name);
  if (ext === '') return false;
  return AUDIO_EXTENSIONS.has(ext.slice(1).toLowerCase());
}

/** `extract_field_media_refs`：`src="..."` / `src='...'` 与 `[sound:...]`。 */
export function extractFieldMediaRefs(text: string): string[] {
  const names: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const relative = text.slice(searchFrom).indexOf('src=');
    if (relative < 0) break;
    const quoteIndex = searchFrom + relative + 4;
    const quote = text[quoteIndex];
    if (quote === '"' || quote === "'") {
      const valueStart = quoteIndex + 1;
      const relativeEnd = text.slice(valueStart).indexOf(quote);
      if (relativeEnd >= 0) {
        const value = text.slice(valueStart, valueStart + relativeEnd);
        if (value !== '') names.push(value);
        searchFrom = valueStart + relativeEnd + 1;
        continue;
      }
    }
    searchFrom = quoteIndex;
  }

  searchFrom = 0;
  for (;;) {
    const relative = text.slice(searchFrom).indexOf('[sound:');
    if (relative < 0) break;
    const valueStart = searchFrom + relative + '[sound:'.length;
    const relativeEnd = text.slice(valueStart).indexOf(']');
    if (relativeEnd < 0) break;
    const value = text.slice(valueStart, valueStart + relativeEnd);
    if (value !== '') names.push(value);
    searchFrom = valueStart + relativeEnd + 1;
  }
  return names;
}

/** `read_media_file_base64`（含 32 MiB 上限）。 */
export function readMediaFileBase64(filePath: string): string {
  let metadata: { kind: string; size: number };
  try {
    metadata = ankiLocalRuntime().stat(filePath);
  } catch (error) {
    throw new Error(`读取媒体文件信息失败: ${(error as Error).message}`);
  }
  if (metadata.kind !== 'file') throw new Error('媒体路径不是常规文件');
  if (metadata.size > ANKI_CONNECT_MAX_MEDIA_BYTES) {
    throw new Error(`媒体文件超过 ${ANKI_CONNECT_MAX_MEDIA_BYTES} 字节上限`);
  }
  try {
    return toBase64(ankiLocalRuntime().readBytes(filePath));
  } catch (error) {
    throw new Error(`读取媒体文件失败: ${(error as Error).message}`);
  }
}

/** `store_media_file_base64`。 */
export async function storeMediaFileBase64(
  filename: string,
  data: string,
  retryTimes: number,
): Promise<void> {
  await invokeAnkiConnectAction('storeMediaFile', { filename, data }, 60, retryTimes);
}

/** `guess_image_mime`。 */
export function guessImageMime(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'bmp': return 'image/bmp';
    default: return 'image/jpeg';
  }
}

/** `upload_local_media`：按文件名幂等去重，失败进入 failed 集与 warnings。 */
export async function uploadLocalMedia(
  filePath: string,
  filename: string,
  uploaded: Set<string>,
  failed: Set<string>,
  warnings: string[],
  retryTimes: number,
): Promise<boolean> {
  if (uploaded.has(filename)) return true;
  if (failed.has(filename)) return false;
  let encoded: string;
  try {
    encoded = readMediaFileBase64(filePath);
  } catch (error) {
    warnings.push(`媒体文件 ${filename} 读取失败，已跳过上传: ${(error as Error).message}`);
    failed.add(filename);
    return false;
  }
  try {
    await storeMediaFileBase64(filename, encoded, retryTimes);
    uploaded.add(filename);
    return true;
  } catch (error) {
    warnings.push(`媒体文件 ${filename} 上传失败，已跳过: ${(error as Error).message}`);
    failed.add(filename);
    return false;
  }
}

/** `media_basename`（`Path::file_name` 语义）。 */
export function mediaBasename(mediaPath: string): string | null {
  const base = path.basename(mediaPath);
  if (base === '' || base === '.' || base === '..') return null;
  return base;
}

// ------------------------------------------------------------------ 图像遮挡闭环

const OCCLUSION_PENDING_IMAGE_SCHEME = 'vlm://';

/** `is_occlusion_card`：带 `_occlusion` 协议字段或 `image-occlusion` tag。 */
export function isOcclusionCard(card: Pick<AnkiCard, 'extra_fields' | 'tags'>): boolean {
  return Object.hasOwn(card.extra_fields, OCCLUSION_FIELD) || card.tags.some((tag) => tag === OCCLUSION_TAG);
}

/** `rebuild_occlusion_cloze_text`：spec 缺失/校验失败返回 null。 */
export function rebuildOcclusionClozeText(
  spec: OcclusionSpec | null,
  imageFileName: string | null,
): string | null {
  if (spec === null) return null;
  const validated = validateSpec(spec, defaultOcclusionConfig());
  if (!validated.ok) return null;
  return buildCardFields(validated.value, imageFileName, null).text;
}

/**
 * `prepare_occlusion_note`：Cloze Text 兜底 + imageRef 并入媒体输入。
 * 非遮挡卡零改动。返回需要追加的 warnings（原地修改 `warnings`）。
 */
export function prepareOcclusionNote(
  card: AnkiCard,
  fields: Record<string, string>,
  warnings: string[],
): void {
  if (!isOcclusionCard(card)) return;

  const spec = parseOcclusionField(card.extra_fields);
  if (spec === null && Object.hasOwn(card.extra_fields, OCCLUSION_FIELD)) {
    warnings.push('遮挡卡的 _occlusion 数据不合法，已按普通卡片同步（图片与遮挡信息可能缺失）');
  }

  const rawImageRef = spec?.imageRef.trim() ?? '';
  const imageRef = rawImageRef !== '' && !rawImageRef.startsWith(OCCLUSION_PENDING_IMAGE_SCHEME)
    ? rawImageRef
    : null;
  if (imageRef !== null && !card.images.includes(imageRef)) card.images.push(imageRef);

  const textKey = Object.keys(fields).find((key) => key.toLowerCase() === 'text');
  if (textKey === undefined) return;
  if ((fields[textKey] ?? '').includes('{{c')) return;

  const imageFileName = imageRef === null ? null : mediaBasename(imageRef);
  const rebuilt = rebuildOcclusionClozeText(spec, imageFileName);
  if (rebuilt !== null) {
    fields[textKey] = rebuilt;
  } else {
    warnings.push('遮挡卡缺少 Cloze 文本且无法从 _occlusion 重建，可能在 Anki 中不可复习');
  }
}

// ------------------------------------------------------------------ 备注构建

/** AnkiConnect `NoteMediaAttachment`（`data`/`url` 互斥且缺省省略）。 */
export interface NoteMediaAttachment {
  data?: string;
  url?: string;
  filename: string;
  fields: string[];
}

/** AnkiConnect `Note`（空媒体数组省略）。 */
export interface AnkiNote {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  tags: string[];
  picture?: NoteMediaAttachment[];
  audio?: NoteMediaAttachment[];
}

/** `serde_json::to_value(&Note)` 的键序与省略规则。 */
export function noteToJson(note: AnkiNote): Record<string, unknown> {
  const value: Record<string, unknown> = {
    deckName: note.deckName,
    modelName: note.modelName,
    fields: note.fields,
    tags: note.tags,
  };
  if (note.picture !== undefined && note.picture.length > 0) {
    value.picture = note.picture.map(attachmentToJson);
  }
  if (note.audio !== undefined && note.audio.length > 0) {
    value.audio = note.audio.map(attachmentToJson);
  }
  return value;
}

function attachmentToJson(attachment: NoteMediaAttachment): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  if (attachment.data !== undefined) value.data = attachment.data;
  if (attachment.url !== undefined) value.url = attachment.url;
  value.filename = attachment.filename;
  if (attachment.fields.length > 0) value.fields = attachment.fields;
  return value;
}

/** `prepare_note_media`：按 `media_mode` 上传/内联/跳过媒体，失败降级为 warnings。 */
export async function prepareNoteMedia(
  card: AnkiCard,
  fields: Record<string, string>,
  uploaded: Set<string>,
  failed: Set<string>,
  warnings: string[],
  options: AnkiConnectSyncOptions,
): Promise<{ picture: NoteMediaAttachment[]; audio: NoteMediaAttachment[] }> {
  if (options.mediaMode === 'skip') return { picture: [], audio: [] };
  const inlineMode = options.mediaMode === 'inline_base64';
  const retryTimes = options.retryTimes;
  const inlined = new Set<string>();

  // 第一步：字段里的本地绝对路径引用 → 文件名（upload）或 data URL（inline）
  for (const key of Object.keys(fields)) {
    const value = fields[key]!;
    let rewritten = value;
    for (const reference of extractFieldMediaRefs(value)) {
      if (!path.isAbsolute(reference)) continue;
      let stat: { kind: string };
      try {
        stat = ankiLocalRuntime().stat(reference);
      } catch {
        continue;
      }
      if (stat.kind !== 'file') continue;
      const filename = mediaBasename(reference);
      if (filename === null) continue;
      if (inlineMode) {
        if (isAudioMediaFilename(filename)) {
          warnings.push(`inline_base64 模式无法内联音频 ${filename}，已保留原引用`);
          continue;
        }
        try {
          const encoded = readMediaFileBase64(reference);
          const dataUrl = `data:${guessImageMime(filename)};base64,${encoded}`;
          rewritten = rewritten.split(reference).join(dataUrl);
          inlined.add(filename);
        } catch (error) {
          warnings.push(`媒体文件 ${filename} 读取失败，已跳过内联: ${(error as Error).message}`);
        }
      } else if (await uploadLocalMedia(reference, filename, uploaded, failed, warnings, retryTimes)) {
        rewritten = rewritten.split(reference).join(filename);
      }
    }
    if (rewritten !== value) fields[key] = rewritten;
  }

  const referenced = new Set<string>();
  for (const value of Object.values(fields)) {
    for (const reference of extractFieldMediaRefs(value)) {
      const filename = mediaBasename(reference);
      if (filename !== null) referenced.add(filename);
    }
  }

  const picture: NoteMediaAttachment[] = [];
  const audio: NoteMediaAttachment[] = [];
  for (const imagePath of card.images) {
    const filename = mediaBasename(imagePath);
    if (filename === null) {
      warnings.push(`媒体路径无有效文件名，已跳过: ${imagePath}`);
      continue;
    }

    if (inlineMode) {
      if (inlined.has(filename)) continue;
      if (isAudioMediaFilename(filename)) {
        warnings.push(`inline_base64 模式无法内联音频 ${filename}，已跳过`);
        continue;
      }
      let encoded: string;
      try {
        encoded = readMediaFileBase64(imagePath);
      } catch (error) {
        warnings.push(`媒体文件 ${filename} 读取失败，已跳过内联: ${(error as Error).message}`);
        continue;
      }
      const dataUrl = `data:${guessImageMime(filename)};base64,${encoded}`;
      if (referenced.has(filename)) {
        const doubleQuoted = `src="${filename}"`;
        const singleQuoted = `src='${filename}'`;
        for (const key of Object.keys(fields)) {
          const value = fields[key]!;
          const rewritten = value
            .split(doubleQuoted).join(`src="${dataUrl}"`)
            .split(singleQuoted).join(`src='${dataUrl}'`);
          if (rewritten !== value) fields[key] = rewritten;
        }
      } else {
        const target = pickTargetField(fields);
        if (target !== null) {
          const current = fields[target] ?? '';
          fields[target] = `${current}${current === '' ? '' : '<br>'}<img src="${dataUrl}">`;
        }
      }
      continue;
    }

    if (referenced.has(filename)) {
      await uploadLocalMedia(imagePath, filename, uploaded, failed, warnings, retryTimes);
      continue;
    }
    let encoded: string;
    try {
      encoded = readMediaFileBase64(imagePath);
    } catch (error) {
      warnings.push(`媒体文件 ${filename} 读取失败，已跳过附加: ${(error as Error).message}`);
      continue;
    }
    const target = pickTargetField(fields);
    const attachment: NoteMediaAttachment = {
      data: encoded,
      filename,
      fields: target === null ? [] : [target],
    };
    if (isAudioMediaFilename(filename)) audio.push(attachment);
    else picture.push(attachment);
  }

  return { picture, audio };
}

/** 附件目标字段：优先 Back/Extra/Front，否则取字典序最小字段。 */
function pickTargetField(fields: Record<string, string>): string | null {
  for (const candidate of ['Back', 'Extra', 'Front']) {
    if (Object.hasOwn(fields, candidate)) return candidate;
  }
  const keys = Object.keys(fields).sort();
  return keys.length === 0 ? null : keys[0]!;
}

// ------------------------------------------------------------------ canAddNotes 分类

export type CanAddFalseReason = 'duplicate' | 'invalid_note';

/** `classify_can_add_false`。 */
export function classifyCanAddFalse(
  note: AnkiNote,
  modelFieldNamesCache: ReadonlyMap<string, readonly string[] | null>,
): CanAddFalseReason {
  if (note.deckName.trim() === '' || note.modelName.trim() === '') return 'invalid_note';

  const cached = modelFieldNamesCache.get(note.modelName);
  if (cached === undefined || cached === null) return 'invalid_note';
  const modelFields = cached;
  if (modelFields.length === 0) return 'invalid_note';
  if (modelFields.some((field) => !Object.hasOwn(note.fields, field))) return 'invalid_note';

  const firstField = modelFields[0];
  if (firstField === undefined) return 'invalid_note';
  if ((note.fields[firstField] ?? '').trim() === '') return 'invalid_note';
  if (Object.values(note.fields).every((value) => value.trim() === '')) return 'invalid_note';
  return 'duplicate';
}

// ------------------------------------------------------------------ 明细同步

/** `AnkiSyncModelError`。 */
export interface AnkiSyncModelError {
  model: string;
  error: string;
}

/** `AnkiSyncReport`：`modelErrors` / `warnings` 为空时省略。 */
export interface AnkiSyncReport {
  noteIds: (number | null)[];
  added: number;
  duplicates: number;
  failed: number;
  createdModels: string[];
  modelErrors?: AnkiSyncModelError[];
  warnings?: string[];
}

/** `serde_json::to_value(&AnkiSyncReport)`（camelCase + 空可选字段省略）。 */
export function syncReportToJson(report: AnkiSyncReport): Record<string, unknown> {
  const value: Record<string, unknown> = {
    noteIds: report.noteIds,
    added: report.added,
    duplicates: report.duplicates,
    failed: report.failed,
    createdModels: report.createdModels,
  };
  if (report.modelErrors !== undefined && report.modelErrors.length > 0) {
    value.modelErrors = report.modelErrors.map((entry) => ({ model: entry.model, error: entry.error }));
  }
  if (report.warnings !== undefined && report.warnings.length > 0) value.warnings = report.warnings;
  return value;
}

/** `is_duplicate_note_error`。 */
export function isDuplicateNoteError(error: string): boolean {
  return error.toLowerCase().includes('duplicate');
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'sequence';
  switch (typeof value) {
    case 'string': return `string ${JSON.stringify(value)}`;
    case 'number': return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
    case 'boolean': return `boolean \`${value}\``;
    case 'object': return 'map';
    default: return 'unit';
  }
}

/** `can_add_notes`：`Vec<bool>` 解析失败文案与 Rust 一致。 */
async function canAddNotes(notes: AnkiNote[], retryTimes: number): Promise<boolean[]> {
  const result = await invokeAnkiConnectAction('canAddNotes', { notes: notes.map(noteToJson) }, 15, retryTimes);
  if (!Array.isArray(result)) {
    throw new Error(`解析 canAddNotes 结果失败: invalid type: ${describeType(result)}, expected a sequence`);
  }
  return result.map((item) => {
    if (typeof item !== 'boolean') {
      throw new Error(`解析 canAddNotes 结果失败: invalid type: ${describeType(item)}, expected a boolean`);
    }
    return item;
  });
}

/** `Vec<Option<u64>>`（多余/null 槽位保留）。 */
function parseNoteIds(value: unknown): (number | null)[] {
  if (!Array.isArray(value)) {
    throw new Error(`invalid type: ${describeType(value)}, expected a sequence`);
  }
  return value.map((item) => {
    if (item === null) return null;
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0) return item;
    throw new Error(`invalid type: ${describeType(item)}, expected u64`);
  });
}

export interface DetailedSyncInput {
  cards: readonly AnkiCard[];
  deckName: string;
  noteType: string;
  cardModels: ReadonlyMap<string, string>;
  templatesByModel: ReadonlyMap<string, CustomAnkiTemplate>;
  options: AnkiConnectSyncOptions;
}

/**
 * `add_notes_to_anki_detailed`：模型预检/自动创建 → 字段与媒体 → canAddNotes 预检 →
 * 分批 addNotes（预检不可用时逐条 addNote 降级）。
 */
export async function addNotesToAnkiDetailed(input: DetailedSyncInput, logger?: AnkiLogger): Promise<AnkiSyncReport> {
  const options = sanitizeSyncOptions(input.options);
  const { cards, deckName, noteType, cardModels, templatesByModel } = input;
  await checkAnkiConnectAvailability(logger);

  const modelFieldNamesCache = new Map<string, readonly string[] | null>();
  const modelNames = [...new Set(cards.map((card) => cardModels.get(card.id) ?? noteType))].sort();

  const createdModels: string[] = [];
  const modelErrors: AnkiSyncModelError[] = [];
  const warnings: string[] = [];

  if (templatesByModel.size > 0) {
    let existing: string[];
    try {
      existing = await getModelNames();
    } catch (error) {
      throw new Error(`无法核对 Anki 模型，发送尚未开始: ${(error as Error).message}`);
    }
    for (const modelName of modelNames) {
      const template = templatesByModel.get(modelName);
      if (existing.includes(modelName)) {
        if (template !== undefined) await verifyExistingTemplateModel(modelName, template);
        continue;
      }
      if (template !== undefined) {
        try {
          await createModelFromTemplate(modelName, template);
          createdModels.push(modelName);
        } catch (error) {
          logger?.warn(`⚠️ 自动创建模型 ${modelName} 失败: ${(error as Error).message}`);
          modelErrors.push({ model: modelName, error: `自动创建模型失败: ${(error as Error).message}` });
        }
      } else {
        logger?.warn(`⚠️ Anki 中缺少模型 ${modelName} 且无对应模板，可能导致同步失败`);
        modelErrors.push({
          model: modelName,
          error: 'Anki 中缺少该模型且本地无对应模板，相关卡片可能同步失败',
        });
      }
    }
  }

  if (modelErrors.length > 0) {
    return {
      noteIds: cards.map(() => null),
      added: 0,
      duplicates: 0,
      failed: cards.length,
      createdModels,
      modelErrors,
      warnings,
    };
  }

  for (const modelName of modelNames) {
    let loaded: readonly string[] | null = null;
    try {
      const names = await getModelFieldNames(modelName);
      loaded = names.length > 0 ? names : null;
    } catch (error) {
      logger?.warn(`⚠️ 获取模型字段失败: ${(error as Error).message} — 将使用基本字段映射`);
      loaded = null;
    }
    if (templatesByModel.has(modelName) && loaded === null) {
      throw new Error(`无法读取 Anki 模型「${modelName}」的字段，发送尚未开始`);
    }
    modelFieldNamesCache.set(modelName, loaded);
  }

  const notes: AnkiNote[] = [];
  const uploadedMedia = new Set<string>();
  const failedMedia = new Set<string>();
  for (const original of cards) {
    const card: AnkiCard = {
      ...original,
      tags: [...original.tags],
      images: [...original.images],
      extra_fields: { ...original.extra_fields },
    };
    const modelName = cardModels.get(card.id) ?? noteType;
    const modelFieldNames = modelFieldNamesCache.get(modelName) ?? null;
    const semanticNoteType = templatesByModel.get(modelName)?.note_type ?? modelName;

    const fields = modelFieldNames !== null
      ? buildFieldsWithModelNames(card, modelFieldNames, semanticNoteType)
      : buildBasicFields(card, semanticNoteType);

    prepareOcclusionNote(card, fields, warnings);
    const { picture, audio } = await prepareNoteMedia(
      card, fields, uploadedMedia, failedMedia, warnings, options,
    );
    notes.push({ deckName, modelName, fields, tags: card.tags, picture, audio });
  }

  const total = notes.length;
  const noteIds: (number | null)[] = notes.map(() => null);
  let duplicates = 0;

  let precheck: boolean[] | null = null;
  let precheckError: string | null = null;
  try {
    const flags = await canAddNotes(notes, options.retryTimes);
    if (flags.length === total) precheck = flags;
    else precheckError = `canAddNotes 返回数量不匹配（期望 ${total}，实际 ${flags.length}）`;
  } catch (error) {
    precheckError = (error as Error).message;
  }

  if (precheck !== null) {
    duplicates = notes.filter(
      (note, index) => !precheck![index]
        && classifyCanAddFalse(note, modelFieldNamesCache) === 'duplicate',
    ).length;

    const addable = precheck
      .map((ok, index) => (ok ? index : -1))
      .filter((index) => index >= 0);

    for (let start = 0; start < addable.length; start += options.batchSize) {
      const chunk = addable.slice(start, start + options.batchSize);
      const chunkNotes = chunk.map((index) => noteToJson(notes[index]!));
      let result: unknown;
      try {
        result = await invokeAnkiConnectAction('addNotes', { notes: chunkNotes }, 60, options.retryTimes);
      } catch (error) {
        logger?.warn(`⚠️ addNotes 批次推送失败（${chunk.length} 张）: ${(error as Error).message}`);
        warnings.push(
          `addNotes 批次推送失败（${chunk.length} 张卡片未写入，可重试续传）: ${(error as Error).message}`,
        );
        continue;
      }
      try {
        const addedIds = parseNoteIds(result);
        chunk.forEach((noteIndex, slot) => {
          noteIds[noteIndex] = addedIds[slot] ?? null;
        });
      } catch (error) {
        warnings.push(
          `解析 addNotes 批次结果失败（${chunk.length} 张卡片未确认写入）: ${(error as Error).message}`,
        );
      }
    }
  } else {
    logger?.warn(`⚠️ canAddNotes 预检不可用，降级为逐条 addNote: ${precheckError ?? ''}`);
    warnings.push(`canAddNotes 预检不可用，已降级为逐条 addNote: ${precheckError ?? ''}`);
    for (const [index, note] of notes.entries()) {
      try {
        const result = await invokeAnkiConnectAction('addNote', { note: noteToJson(note) }, 30, options.retryTimes);
        if (typeof result === 'number' && Number.isInteger(result) && result >= 0) noteIds[index] = result;
        else duplicates += 1;
      } catch (error) {
        const message = (error as Error).message;
        if (isDuplicateNoteError(message)) duplicates += 1;
        else warnings.push(`第 ${index + 1} 张卡片 addNote 失败: ${message}`);
      }
    }
  }

  const added = noteIds.filter((id) => id !== null).length;
  const failed = Math.max(0, total - (added + duplicates));
  return { noteIds, added, duplicates, failed, createdModels, modelErrors, warnings };
}

/** `contains_cloze_markup`（`cmd/anki_connect.rs:17-20`）：trim 后同时含 `{{c` 与 `}}`。 */
export function containsClozeMarkup(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.includes('{{c') && trimmed.includes('}}');
}

/** `card_has_cloze_markup`：text / front / back / 任意 extra 字段。 */
export function cardHasClozeMarkup(card: Pick<AnkiCard, 'text' | 'front' | 'back' | 'extra_fields'>): boolean {
  if (card.text !== null && containsClozeMarkup(card.text)) return true;
  if (containsClozeMarkup(card.front) || containsClozeMarkup(card.back)) return true;
  return Object.values(card.extra_fields).some(containsClozeMarkup);
}
