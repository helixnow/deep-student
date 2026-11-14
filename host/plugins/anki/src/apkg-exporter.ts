/**
 * APKG 导出（`dstu-anki/src/apkg_exporter_service.rs` 全量移植）。
 *
 * 产物是 Anki 可导入的 `.apkg`：`collection.anki2`（Anki 2 schema）+ `media`
 * 清单 + 数字命名的媒体条目。单模板与多模板路径共用字段解析、Cloze ord、
 * 调度回写与媒体收集逻辑。
 */
import { encodeUtf8 } from '../../../platform/util/utf8.ts';
import { compareUtf8, utf8ByteLength } from '../../../platform/util/portable.ts';
import { hostPath as path } from '../../../platform/util/path.ts';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { AnkiLogger } from './logger.ts';
import { ioErrorText } from './files.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import {
  createAnkiSchema,
  insertCardRow,
  insertCollectionRow,
  insertNoteRow,
  insertRevlogRowIfAbsent,
} from '../repository/apkg-export.ts';
import { buildZip, type ZipEntry } from './apkg-zip.ts';
import {
  defaultOcclusionConfig,
  formatAnkiIoCloze,
  parseOcclusionField,
  validateSpec,
  type OcclusionSpec,
} from './image-occlusion.ts';

import {
  APKG_EXPORT_DECK_ID,
  APKG_MODEL_ID_BASE,
  DEEP_STUDENT_COLLAPSE_CLOZE_ORDS_KEY,
  DEEP_STUDENT_TEMPLATE_ID_KEY,
  MAX_EXPORT_MEDIA_FILE_BYTES,
  RESERVED_IMPORT_METADATA_FIELDS,
  type TemplateConfigTuple,
} from './apkg-export-constants.ts';
import type { CardSchedRestore, RevlogExport } from './apkg-export-model.ts';
import {
  ANKI_COLLECTION_CONFIG,
  cleanTemplatePlaceholders,
  clozeCardOrds,
  containsClozeMarker,
  convertOcclusionCardForExport,
  createBasicModel,
  createClozeModel,
  createTemplateModel,
  fileNameOf,
  fieldChecksum,
  formatIoRects,
  fsrsSchedRestore,
  humanizeCitationMarkers,
  initializeAnkiDatabaseWithTemplate,
  insertCollection,
  isInternalProtocolField,
  isReservedImportMetadataField,
  nextApkgCardId,
  nextApkgNoteId,
  normalizeCardsForExport,
  occlusionMediaFileName,
  resolveCardFieldValue,
  sanitizeApkgFieldValue,
  cardSchedRestore,
  stableModelIdForTemplate,
  stableNoteGuid,
  uniqueNoteGuid,
} from './apkg-export-model.ts';
export * from './apkg-export-constants.ts';
export * from './apkg-export-model.ts';


export interface ApkgExportRuntime {
  logger: Pick<AnkiLogger, 'warn'>;
  openDatabase(filePath: string): DatabaseHandle;
  closeDatabase(handle: DatabaseHandle): void;
  /** `std::env::temp_dir()`。 */
  tempDir: string;
  now?: () => number;
}

export interface ApkgExportReport {
  exportedMedia: number;
  missingMedia: string[];
  warnings: string[];
}

/** `(note_id, guid, flds, sort_field, csum, tags, card_ords, schedules, instance)`。 */
export type AnkiNoteRecord = [
  noteId: string,
  guid: string,
  fields: string,
  sortField: string,
  csum: number,
  tags: string,
  cardOrds: number[],
  schedules: Array<CardSchedRestore | null>,
  instance: boolean,
];

// ============================== 记录转换 ==============================

export function isImportedClozeInstance(card: AnkiCard): boolean {
  const scope = card.extra_fields.AnkiCardScope;
  if (scope === 'card') return true;
  if (scope === 'note') return false;
  return card.template_id === null && card.extra_fields.AnkiCardOrd !== undefined;
}

function importedSourceKey(card: AnkiCard): [string, string, string] | null {
  const modelId = card.extra_fields.AnkiModelId;
  if (modelId === undefined) throw new Error('导入卡片缺少 AnkiModelId');
  const noteId = card.extra_fields.AnkiNoteId;
  if (noteId === undefined) throw new Error('导入卡片缺少 AnkiNoteId');
  return [card.task_id, modelId, noteId];
}

/** `convert_cards_to_anki_records_with_fields`（`apkg_exporter_service.rs:1532-1703`）。 */
export function convertCardsToAnkiRecordsWithFields(
  cards: readonly AnkiCard[],
  modelName: string,
  templateFields: readonly string[] | null,
  logger?: Pick<AnkiLogger, 'warn'>,
): AnkiNoteRecord[] {
  const records: AnkiNoteRecord[] = [];
  const isClozeModel = modelName.toLowerCase() === 'cloze';
  const usedGuids = new Set<string>();
  const importedNotes = new Map<string, number>();

  for (const card of cards) {
    const noteId = nextApkgNoteId();
    const instance = isClozeModel && isImportedClozeInstance(card);
    const sourceKey = instance ? importedSourceKey(card) : null;

    let fields: string;
    let sortField: string;
    if (templateFields !== null) {
      const values = templateFields.map((fieldName) =>
        sanitizeApkgFieldValue(resolveCardFieldValue(card, fieldName, logger)));
      fields = values.join('\u001f');
      sortField = values[0] ?? '';
    } else {
      const front = sanitizeApkgFieldValue(cleanTemplatePlaceholders(card.front));
      const back = sanitizeApkgFieldValue(cleanTemplatePlaceholders(card.back));
      fields = `${front}\u001f${back}`;
      sortField = front;
    }

    const cleanedTags = card.tags
      .map((tag) => cleanTemplatePlaceholders(tag))
      .filter((tag) => tag !== '')
      .sort((a, b) => compareUtf8(a, b));
    const uniqueTags = [...new Set(cleanedTags)];
    const tags = uniqueTags.join(' ');
    const csum = fieldChecksum(sortField);

    let cardOrds: number[];
    if (isClozeModel) {
      const allOrds = clozeCardOrds(resolveCardFieldValue(card, 'Text', logger));
      if (instance) {
        const ord = Number(card.extra_fields.AnkiCardOrd);
        if (!Number.isInteger(ord) || !allOrds.includes(ord)) {
          throw new Error(`卡片 ${card.id} 的挖空编号与正文不一致`);
        }
        cardOrds = [ord];
      } else {
        cardOrds = allOrds;
      }
    } else {
      cardOrds = [0];
    }

    const schedule = cardSchedRestore(card);

    if (sourceKey !== null) {
      const key = `${sourceKey[0]}\u0000${sourceKey[1]}\u0000${sourceKey[2]}`;
      const existingIndex = importedNotes.get(key);
      if (existingIndex !== undefined) {
        const record = records[existingIndex]!;
        if (record[2] !== fields || record[5] !== tags) {
          throw new Error(`同源挖空卡片 ${card.id} 的字段或标签已分别修改，请统一内容后导出`);
        }
        const ord = cardOrds[0]!;
        const position = record[6].indexOf(ord);
        if (position >= 0) {
          const existingSchedule = record[7][position] ?? null;
          if (JSON.stringify(existingSchedule) !== JSON.stringify(schedule)) {
            throw new Error(`同源挖空卡片 ${card.id} 的复习进度不一致`);
          }
        } else {
          record[6].push(ord);
          record[7].push(schedule);
        }
        continue;
      }
    }

    let guid: string;
    if (sourceKey !== null) {
      const identityCard: AnkiCard = structuredClone(card);
      identityCard.id = `apkg:${utf8ByteLength(sourceKey[0])}:${sourceKey[0]}`
        + `:${utf8ByteLength(sourceKey[1])}:${sourceKey[1]}`
        + `:${utf8ByteLength(sourceKey[2])}:${sourceKey[2]}`;
      importedNotes.set(`${sourceKey[0]}\u0000${sourceKey[1]}\u0000${sourceKey[2]}`, records.length);
      guid = uniqueNoteGuid(identityCard, usedGuids);
    } else {
      guid = uniqueNoteGuid(card, usedGuids);
    }

    records.push([
      String(noteId),
      guid,
      fields,
      sortField,
      csum,
      tags,
      cardOrds,
      cardOrds.map(() => schedule),
      instance,
    ]);
  }
  return records;
}

// ============================== 写入 collection ==============================

function insertRevlogRow(db: DatabaseHandle, cardId: number, entry: RevlogExport): void {
  let id = entry.idMs;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const inserted = insertRevlogRowIfAbsent(db, {
      id,
      cardId,
      ease: entry.ease,
      ivl: entry.ivl,
      lastIvl: entry.lastIvl,
      factor: entry.factor,
      timeMs: entry.timeMs,
      kind: entry.kind,
    });
    if (inserted) return;
    id += 1;
  }
  throw new Error('复习记录主键冲突过多');
}

export function insertAnkiCardRows(
  db: DatabaseHandle,
  noteId: number,
  deckId: number,
  nowSeconds: number,
  cardOrds: readonly number[],
  nextDue: { value: number },
  schedule: CardSchedRestore | null,
): void {
  for (const ord of cardOrds) {
    const cardId = nextApkgCardId();
    if (schedule !== null && schedule.fsrs !== null) {
      const fsrs = schedule.fsrs;
      insertCardRow(db, {
        id: cardId,
        noteId,
        deckId,
        ord,
        mod: nowSeconds,
        type: fsrs.cardType,
        queue: fsrs.queue,
        due: schedule.due,
        ivl: schedule.ivl,
        factor: schedule.factor,
        reps: schedule.reps,
        lapses: schedule.lapses,
        left: fsrs.left,
        data: fsrs.data,
      });
      for (const entry of fsrs.revlog) insertRevlogRow(db, cardId, entry);
      continue;
    }
    if (schedule !== null) {
      insertCardRow(db, {
        id: cardId,
        noteId,
        deckId,
        ord,
        mod: nowSeconds,
        type: 2,
        queue: 2,
        due: schedule.due,
        ivl: schedule.ivl,
        factor: schedule.factor,
        reps: schedule.reps,
        lapses: schedule.lapses,
        left: 0,
        data: '',
      });
      continue;
    }
    const due = nextDue.value;
    nextDue.value += 1;
    insertCardRow(db, {
      id: cardId,
      noteId,
      deckId,
      ord,
      mod: nowSeconds,
      type: 0,
      queue: 0,
      due,
      ivl: 0,
      factor: 2500,
      reps: 0,
      lapses: 0,
      left: 0,
      data: '',
    });
  }
}

export function insertAnkiNoteRecords(
  db: DatabaseHandle,
  records: readonly AnkiNoteRecord[],
  modelId: number,
  deckId: number,
  nowSeconds: number,
  nextDue: { value: number },
): void {
  for (const [noteId, guid, fields, sortField, csum, tags, ords, schedules, instance] of records) {
    const parsedNoteId = Number(noteId);
    if (!Number.isSafeInteger(parsedNoteId)) throw new Error(`invalid note id: ${noteId}`);
    insertNoteRow(db, {
      id: parsedNoteId,
      guid,
      modelId,
      mod: nowSeconds,
      tags,
      fields,
      sortField: cleanTemplatePlaceholders(sortField),
      csum,
      data: JSON.stringify({ deepStudentCardScope: instance ? 'card' : 'note' }),
    });
    for (let index = 0; index < ords.length; index += 1) {
      insertAnkiCardRows(db, parsedNoteId, deckId, nowSeconds, [ords[index]!], nextDue, schedules[index] ?? null);
    }
  }
}

// ============================== 媒体 ==============================

export interface CollectedMedia {
  entries: Array<{ name: string; data: Uint8Array }>;
  missing: string[];
  warnings: string[];
}

/** `collect_media_entries`（`apkg_exporter_service.rs:1723-1780`）。 */
export function collectMediaEntries(cards: readonly AnkiCard[], logger?: Pick<AnkiLogger, 'warn'>): CollectedMedia {
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const seenSources = new Map<string, string>();

  for (const card of cards) {
    for (const imagePath of card.images) {
      const fileName = fileNameOf(imagePath);
      if (fileName === null) {
        logger?.warn(`媒体路径无有效文件名，跳过: ${imagePath}`);
        missing.push(imagePath);
        continue;
      }
      const firstSource = seenSources.get(fileName);
      if (firstSource !== undefined) {
        if (firstSource !== imagePath) {
          const message = `媒体同名冲突：${firstSource} 与 ${imagePath} 文件名相同（${fileName}），仅导出首个来源，后者被跳过`;
          logger?.warn(message);
          warnings.push(message);
        }
        continue;
      }
      seenSources.set(fileName, imagePath);
      try {
        const stat = ankiLocalRuntime().stat(imagePath);
        if (stat.size > MAX_EXPORT_MEDIA_FILE_BYTES) {
          const message = `媒体文件超过 ${MAX_EXPORT_MEDIA_FILE_BYTES} 字节导出上限，已跳过: ${imagePath} (${stat.size} 字节)`;
          logger?.warn(message);
          warnings.push(message);
          missing.push(imagePath);
          continue;
        }
        entries.push({ name: fileName, data: ankiLocalRuntime().readBytes(imagePath) });
      } catch (error) {
        logger?.warn(`读取媒体文件失败，跳过并继续导出 ${imagePath}: ${ioErrorText(error)}`);
        missing.push(imagePath);
      }
    }
  }
  return { entries, missing, warnings };
}

function mediaZipEntries(media: CollectedMedia): ZipEntry[] {
  const map: Record<string, string> = {};
  media.entries.forEach((entry, index) => {
    map[String(index)] = entry.name;
  });
  const entries: ZipEntry[] = [{ name: 'media', data: encodeUtf8(JSON.stringify(map)) }];
  media.entries.forEach((entry, index) => {
    entries.push({ name: String(index), data: entry.data });
  });
  return entries;
}

function writeZipFile(outputPath: string, entries: readonly ZipEntry[]): number {
  const parent = path.dirname(outputPath);
  ankiLocalRuntime().mkdirp(parent);
  const tempPath = path.join(parent, `.${path.basename(outputPath)}.${globalThis.crypto.randomUUID()}.tmp`);
  const archive = buildZip(entries);
  ankiLocalRuntime().writeBytes(tempPath, archive);
  ankiLocalRuntime().rename(tempPath, outputPath);
  return ankiLocalRuntime().stat(outputPath).size;
}

function createTempDir(runtime: ApkgExportRuntime): string {
  const now = runtime.now?.() ?? Date.now();
  const dir = path.join(runtime.tempDir, `anki_export_${Math.floor(now / 1000)}_${globalThis.crypto.randomUUID().replace(/-/g, '')}`);
  ankiLocalRuntime().mkdirp(dir);
  return dir;
}

/** Rust 单模板清理失败 warn，multi-report 的 `let _ = remove_dir_all` 只忽略同一错误。 */
function cleanupTempDir(tempDir: string): string | null {
  try {
    ankiLocalRuntime().removeDir(tempDir);
    return null;
  } catch (error) {
    return ioErrorText(error);
  }
}

function cloneCards(cards: readonly AnkiCard[]): AnkiCard[] {
  return cards.map((card) => structuredClone(card));
}

function appendExtraFieldKeys(
  fields: string[],
  cards: readonly AnkiCard[],
): void {
  const extraKeys = cards
    .flatMap((card) => Object.keys(card.extra_fields))
    .filter((key) => !isInternalProtocolField(key));
  extraKeys.sort((a, b) => compareUtf8(a.toLowerCase(), b.toLowerCase()));
  const deduped: string[] = [];
  for (const key of extraKeys) {
    if (!deduped.some((existing) => existing.toLowerCase() === key.toLowerCase())) deduped.push(key);
  }
  for (const key of deduped) {
    if (!fields.some((field) => field.toLowerCase() === key.toLowerCase())) fields.push(key);
  }
}

function ensureMandatoryFields(fields: string[], mandatory: readonly string[]): void {
  for (const name of mandatory) {
    if (!fields.some((field) => field.toLowerCase() === name.toLowerCase())) fields.push(name);
  }
}

function isClozeNoteType(noteType: string): boolean {
  return noteType.toLowerCase() === 'cloze';
}

function writeExport(
  runtime: ApkgExportRuntime,
  cards: AnkiCard[],
  deckName: string,
  noteType: string,
  outputPath: string,
  templateConfig: TemplateConfigTuple | null,
  fullTemplate: CustomAnkiTemplate | null,
): ApkgExportReport {
  if (cards.length === 0) throw new Error('没有卡片可以导出');
  const normalized = cloneCards(cards);
  normalizeCardsForExport(normalized);
  const cardsForMedia = cloneCards(normalized);
  const tempDir = createTempDir(runtime);
  const dbPath = path.join(tempDir, 'collection.anki2');
  const nowMs = runtime.now?.() ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);

  try {
    const db = runtime.openDatabase(dbPath);
    try {
      createAnkiSchema(db);
      const cloze = isClozeNoteType(noteType);
      const fields = templateConfig !== null
        ? [...templateConfig[1]]
        : cloze
          ? ['Text', 'Extra']
          : ['Front', 'Back'];
      appendExtraFieldKeys(fields, normalized);
      ensureMandatoryFields(fields, cloze ? ['Text', 'Extra'] : ['Front', 'Back']);

      const modelConfig: TemplateConfigTuple = templateConfig !== null
        ? [templateConfig[0], fields, templateConfig[2], templateConfig[3], templateConfig[4]]
        : cloze
          ? [
            'Cloze',
            fields,
            '{{cloze:Text}}',
            '{{cloze:Text}}<br>{{Extra}}',
            '.card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n.cloze {\n font-weight: bold;\n color: blue;\n}',
          ]
          : [
            noteType,
            fields,
            '{{Front}}',
            '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}',
            '.card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}',
          ];

      const fullTemplateId = fullTemplate !== null && 'id' in fullTemplate ? fullTemplate.id : null;
      const [deckId, modelId] = initializeAnkiDatabaseWithTemplate(
        db,
        deckName,
        noteType,
        modelConfig,
        fullTemplateId,
        nowSeconds,
      );

      const records = convertCardsToAnkiRecordsWithFields(normalized, noteType, fields, runtime.logger);
      db.exec('BEGIN IMMEDIATE');
      try {
        insertAnkiNoteRecords(db, records, modelId, deckId, nowSeconds, { value: 1 });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      runtime.closeDatabase(db);
    }

    const media = collectMediaEntries(cardsForMedia, runtime.logger);
    const entries: ZipEntry[] = [
      { name: 'collection.anki2', data: ankiLocalRuntime().readBytes(dbPath) },
      ...mediaZipEntries(media),
    ];
    const size = writeZipFile(outputPath, entries);
    if (size === 0) throw new Error(`APKG文件为空 (0字节)，路径: ${outputPath}`);
    return { exportedMedia: media.entries.length, missingMedia: media.missing, warnings: media.warnings };
  } finally {
    const cleanupError = cleanupTempDir(tempDir);
    if (cleanupError !== null) runtime.logger.warn(`警告：清理临时目录失败: ${cleanupError}`);
  }
}

/** Rust `export_cards_to_apkg_with_full_template`：丢弃报告的入口额外记录缺失媒体汇总。 */
export function exportCardsToApkgWithFullTemplate(
  runtime: ApkgExportRuntime,
  cards: readonly AnkiCard[],
  deckName: string,
  noteType: string,
  outputPath: string,
  templateConfig: TemplateConfigTuple | null,
  fullTemplate: CustomAnkiTemplate | null,
): void {
  const report = exportCardsToApkgWithFullTemplateReport(
    runtime, cards, deckName, noteType, outputPath, templateConfig, fullTemplate,
  );
  if (report.missingMedia.length > 0) {
    const paths = report.missingMedia.map((name) => JSON.stringify(name)).join(', ');
    runtime.logger.warn(`APKG 导出完成，但 ${report.missingMedia.length} 个媒体文件缺失: [${paths}]`);
  }
}

/** `export_cards_to_apkg_with_full_template_report`（`apkg_exporter_service.rs:1866-2072`）。 */
export function exportCardsToApkgWithFullTemplateReport(
  runtime: ApkgExportRuntime,
  cards: readonly AnkiCard[],
  deckName: string,
  noteType: string,
  outputPath: string,
  templateConfig: TemplateConfigTuple | null,
  fullTemplate: CustomAnkiTemplate | null,
): ApkgExportReport {
  return writeExport(runtime, cloneCards(cards), deckName, noteType, outputPath, templateConfig, fullTemplate);
}

/** `export_multi_template_apkg_report`（`apkg_exporter_service.rs:2101-2385`）。 */
export function exportMultiTemplateApkgReport(
  runtime: ApkgExportRuntime,
  cards: readonly AnkiCard[],
  deckName: string,
  outputPath: string,
  templateMap: ReadonlyMap<string, CustomAnkiTemplate>,
): ApkgExportReport {
  if (cards.length === 0) throw new Error('没有卡片可以导出');
  const normalized = cloneCards(cards);
  normalizeCardsForExport(normalized);
  const cardsForMedia = cloneCards(normalized);
  const tempDir = createTempDir(runtime);
  const dbPath = path.join(tempDir, 'collection.anki2');
  const nowMs = runtime.now?.() ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);

  try {
    const db = runtime.openDatabase(dbPath);
    try {
      createAnkiSchema(db);
      const deckId = APKG_EXPORT_DECK_ID;

      const groups = new Map<string, AnkiCard[]>();
      const noTemplateCards: AnkiCard[] = [];
      const noTemplateClozeCards: AnkiCard[] = [];
      for (const card of normalized) {
        const templateId = card.template_id?.trim();
        if (templateId !== undefined && templateId !== '') {
          const group = groups.get(templateId);
          if (group === undefined) groups.set(templateId, [card]);
          else group.push(card);
        } else if (containsClozeMarker(resolveCardFieldValue(card, 'Text', runtime.logger))) {
          noTemplateClozeCards.push(card);
        } else {
          noTemplateCards.push(card);
        }
      }

      const models: Record<string, unknown> = {};
      const modelIds = new Map<string, number>();
      const modelFields = new Map<string, string[]>();
      for (const [templateId, groupCards] of groups) {
        const modelId = stableModelIdForTemplate(templateId);
        modelIds.set(templateId, modelId);
        const template = templateMap.get(templateId);
        if (template !== undefined) {
          const fields = [...template.fields];
          appendExtraFieldKeys(fields, groupCards);
          const cloze = isClozeNoteType(template.note_type);
          ensureMandatoryFields(fields, cloze ? ['Text', 'Extra', 'Front', 'Back'] : ['Front', 'Back']);
          const model = createTemplateModel(
            String(modelId),
            template.name,
            fields,
            template.front_template,
            template.back_template,
            template.css_style,
            cloze ? 1 : 0,
            nowSeconds,
          );
          modelFields.set(templateId, fields);
          const modelValue = model as unknown as Record<string, unknown>;
          modelValue[DEEP_STUDENT_TEMPLATE_ID_KEY] = templateId;
          modelValue[DEEP_STUDENT_COLLAPSE_CLOZE_ORDS_KEY] = true;
          models[String(modelId)] = modelValue;
        } else {
          modelFields.set(templateId, ['Front', 'Back']);
          const model = createBasicModel(nowSeconds) as unknown as Record<string, unknown>;
          model.id = modelId;
          models[String(modelId)] = model;
        }
      }

      const fallbackModelId = APKG_MODEL_ID_BASE;
      const fallbackClozeModelId = APKG_MODEL_ID_BASE - 1;
      const fallbackClozeFields = ['Text', 'Extra', 'Front', 'Back'];
      if (noTemplateClozeCards.length > 0) {
        const model = createTemplateModel(
          String(fallbackClozeModelId),
          'Cloze',
          fallbackClozeFields,
          '{{cloze:Text}}',
          '{{cloze:Text}}<br>{{Extra}}',
          createClozeModel(nowSeconds).css,
          1,
          nowSeconds,
        );
        models[String(fallbackClozeModelId)] = model;
      }
      if (noTemplateCards.length > 0) {
        const basic = createBasicModel(nowSeconds) as unknown as Record<string, unknown>;
        basic.id = fallbackModelId;
        models[String(fallbackModelId)] = basic;
      }

      insertCollection(db, models, deckName, nowSeconds);

      db.exec('BEGIN IMMEDIATE');
      try {
        const nextDue = { value: 1 };
        for (const [templateId, groupCards] of groups) {
          const modelId = modelIds.get(templateId) ?? fallbackModelId;
          const fields = modelFields.get(templateId) ?? ['Front', 'Back'];
          const template = templateMap.get(templateId);
          const cloze = template !== undefined && isClozeNoteType(template.note_type);
          const records = convertCardsToAnkiRecordsWithFields(
            groupCards,
            cloze ? 'Cloze' : 'Basic',
            fields,
            runtime.logger,
          );
          insertAnkiNoteRecords(db, records, modelId, deckId, nowSeconds, nextDue);
        }
        const basicRecords = convertCardsToAnkiRecordsWithFields(
          noTemplateCards,
          'Basic',
          ['Front', 'Back'],
          runtime.logger,
        );
        insertAnkiNoteRecords(db, basicRecords, fallbackModelId, deckId, nowSeconds, nextDue);
        const clozeRecords = convertCardsToAnkiRecordsWithFields(
          noTemplateClozeCards,
          'Cloze',
          fallbackClozeFields,
          runtime.logger,
        );
        insertAnkiNoteRecords(db, clozeRecords, fallbackClozeModelId, deckId, nowSeconds, nextDue);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      runtime.closeDatabase(db);
    }

    const media = collectMediaEntries(cardsForMedia, runtime.logger);
    const entries: ZipEntry[] = [
      { name: 'collection.anki2', data: ankiLocalRuntime().readBytes(dbPath) },
      ...mediaZipEntries(media),
    ];
    writeZipFile(outputPath, entries);
    return { exportedMedia: media.entries.length, missingMedia: media.missing, warnings: media.warnings };
  } finally {
    // Rust multi-report 不记录清理日志，且不得以清理错误替换主结果。
    cleanupTempDir(tempDir);
  }
}

/** `ApkgExportReport` 的 serde 投影（空数组字段省略）。 */
export function apkgExportReportJson(report: ApkgExportReport): {
  exportedMedia: number;
  missingMedia?: string[];
  warnings?: string[];
} {
  return {
    exportedMedia: report.exportedMedia,
    ...(report.missingMedia.length === 0 ? {} : { missingMedia: report.missingMedia }),
    ...(report.warnings.length === 0 ? {} : { warnings: report.warnings }),
  };
}
