/**
 * 集合库 SQLite 内省与卡片展开（legacy 与现代 anki21b 共用）。
 */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { emptyApkgMediaReport } from './apkg-types.ts';
import type { AnkiLogger } from './logger.ts';
import {
  cardsTableHasColumn,
  collectionObjectType,
  countCollectionCards,
  iterateLegacyCollectionCards,
  listCardsTableColumnNames,
  listModernDeckNames,
  listModernFields,
  listModernNotetypes,
  listTableColumns,
  notesTableHasDataColumn,
  prepareReadOnlyCollection,
  readCollectionCrt,
  readLegacyCollectionMetadata,
  type LegacyCollectionCardRow,
} from '../repository/apkg-import.ts';
import {
  APKG_ERROR_COLLECTION_INVALID,
  APKG_ERROR_MODERN_SCHEMA,
  ANKI_DUE_TIMESTAMP_THRESHOLD,
  DEFAULT_DECK_ID,
  MAX_CARDS,
  MAX_DECKS_JSON_BYTES,
  MAX_MODELS_JSON_BYTES,
  MAX_FIELDS_PER_MODEL,
  MAX_TAG_BYTES,
  MS_PER_DAY,
  byteLen,
  collectionSqlError,
  databaseError,
  errorMessage,
  isAppErrorValue,
  limitError,
  trimWhitespace,
  validationError,
  compareUtf8,
  type ApkgCollectionRuntime,
  type ApkgImportRuntime,
  type CardSchedState,
  type ModelDefinition,
  type ParsedCard,
  type ParsedPackage,
  type TemplateImportCandidate,
} from './apkg-import-types.ts';
import { mapCard, validateAndEstimateCard } from './apkg-import-mapping.ts';
import { dedupeSorted, parseDeckNames, parseModels } from './apkg-import-metadata.ts';
import { parseNotetypeKind } from './apkg-import-zstd.ts';
import { collectCardMediaPaths } from './apkg-import-media.ts';

// ============================================================================
// 集合库 schema 校验
// ============================================================================

function validateRealTable(db: DatabaseHandle, table: string): void {
  const objectType = collectionObjectType(db, table);
  if (objectType !== 'table') {
    throw validationError(
      APKG_ERROR_COLLECTION_INVALID,
      `APKG collection object ${table} must be a real table`,
    );
  }
}

function validateTableColumns(
  db: DatabaseHandle,
  table: string,
  required: readonly string[],
  requiredPrimaryKeys: readonly string[],
): void {
  const rows = listTableColumns(db, table);
  const columns = new Map<string, number>();
  for (const row of rows) columns.set(row.name, row.pk);
  for (const column of required) {
    if (!columns.has(column)) {
      throw validationError(
        APKG_ERROR_COLLECTION_INVALID,
        `APKG collection table ${table} is missing required column ${column}`,
      );
    }
  }
  for (const column of requiredPrimaryKeys) {
    if ((columns.get(column) ?? 0) <= 0) {
      throw validationError(
        APKG_ERROR_COLLECTION_INVALID,
        `APKG collection column ${table}.${column} must be a primary key`,
      );
    }
  }
}

function validateCollectionSchema(db: DatabaseHandle): void {
  for (const table of ['col', 'notes', 'cards']) validateRealTable(db, table);
  validateTableColumns(db, 'col', ['models', 'decks'], []);
  validateTableColumns(db, 'notes', ['id', 'mid', 'tags', 'flds'], ['id']);
  validateTableColumns(db, 'cards', ['id', 'nid', 'did', 'ord'], ['id']);
}

/** 现代 schema（anki21b）：notetypes/fields/decks 为独立表，col.models/decks 不再可用。 */
function validateModernCollectionSchema(db: DatabaseHandle): void {
  for (const table of ['notes', 'cards', 'notetypes', 'decks', 'fields']) validateRealTable(db, table);
  validateTableColumns(db, 'notes', ['id', 'mid', 'tags', 'flds'], ['id']);
  validateTableColumns(db, 'cards', ['id', 'nid', 'did', 'ord'], ['id']);
  validateTableColumns(db, 'notetypes', ['id', 'name', 'config'], ['id']);
  validateTableColumns(db, 'decks', ['id', 'name'], ['id']);
  validateTableColumns(db, 'fields', ['ntid', 'ord', 'name'], []);
}

// ------------------------------------------------------------------ 现代模型

/** 从现代 schema 的 notetypes + fields 表重建 ModelDefinition。 */
function loadModernModels(db: DatabaseHandle, warnings: string[]): Map<number, ModelDefinition> {
  const fieldsByNotetype = new Map<number, Array<{ ord: number; name: string }>>();
  for (const row of listModernFields(db)) {
    const entry = fieldsByNotetype.get(row.ntid) ?? [];
    if (entry.length >= MAX_FIELDS_PER_MODEL) {
      throw validationError(
        APKG_ERROR_COLLECTION_INVALID,
        `APKG notetype ${row.ntid} has too many fields`,
      );
    }
    entry.push({ ord: row.ord, name: row.name });
    fieldsByNotetype.set(row.ntid, entry);
  }

  const models = new Map<number, ModelDefinition>();
  for (const notetype of listModernNotetypes(db)) {
    const modelType = parseNotetypeKind(notetype.config);
    const orderedFields = (fieldsByNotetype.get(notetype.id) ?? []).filter(
      (field) => field.ord >= 0 && field.ord < MAX_FIELDS_PER_MODEL && trimWhitespace(field.name) !== '',
    );
    orderedFields.sort((left, right) => left.ord - right.ord);
    const deduped: Array<{ ord: number; name: string }> = [];
    for (const field of orderedFields) {
      if (deduped.length === 0 || deduped[deduped.length - 1]!.ord !== field.ord) deduped.push(field);
    }

    let fieldSlotCount: number;
    let fieldsByOrd: Map<number, string>;
    if (deduped.length === 0) {
      // 字段表缺失/异常：退化为按位置映射，上限放宽到 MAX_FIELDS_PER_MODEL。
      warnings.push(
        `APKG 笔记类型 ${notetype.name}（${notetype.id}）缺少字段定义，已按字段位置导入`,
      );
      fieldSlotCount = MAX_FIELDS_PER_MODEL;
      fieldsByOrd = new Map();
    } else {
      fieldSlotCount = deduped[deduped.length - 1]!.ord + 1;
      fieldsByOrd = new Map(deduped.map((field) => [field.ord, field.name]));
    }

    models.set(notetype.id, {
      name: notetype.name,
      modelType,
      fieldsByOrd,
      fieldSlotCount,
      // 现代包不携带 Deep Student 模板身份，不臆造 template_id。
      templateId: null,
      collapseClozeOrds: false,
    });
  }

  if (models.size === 0) {
    throw validationError(APKG_ERROR_COLLECTION_INVALID, 'APKG collection contains no notetypes');
  }
  return models;
}

/** 现代 schema `decks.name` 用 U+001F 分隔层级，转为 Anki 惯用的 `::` 展示形式。 */
function loadModernDeckNamesForDisplay(db: DatabaseHandle): string[] {
  const names: string[] = [];
  for (const raw of listModernDeckNames(db)) {
    const display = raw.replace(/\u001f/g, '::');
    if (trimWhitespace(display) !== '') names.push(display);
  }
  names.sort(compareUtf8);
  return dedupeSorted(names);
}

// ============================================================================
// 集合库解析
// ============================================================================

interface PendingCardRow {
  cardId: number;
  cardOrd: number;
  deckId: number;
  sched: CardSchedState | null;
}

interface PendingNoteGroup {
  modelId: number;
  noteId: number;
  rawTags: string;
  rawFields: string;
  collapseClozeOrds: boolean;
  rows: PendingCardRow[];
}

function readRowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

function readRowText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function readRowOptionalNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

function readRowOptionalText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

/** 解析 Anki `cards.data`（JSON）里的 FSRS 记忆状态与上次复习时间。 */
export function parseCardFsrsData(raw: string): [[number, number] | null, number | null] {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return [null, null];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [null, null];
  const record = value as Record<string, unknown>;
  const rawStability = record.s;
  const stability = typeof rawStability === 'number' && Number.isFinite(rawStability) && rawStability > 0
    ? rawStability
    : null;
  const rawDifficulty = record.d;
  const difficulty = typeof rawDifficulty === 'number' && Number.isFinite(rawDifficulty)
    && rawDifficulty >= 1 && rawDifficulty <= 10
    ? rawDifficulty
    : null;
  const rawLastReview = record.lrt;
  const lastReview = typeof rawLastReview === 'number' && Number.isInteger(rawLastReview)
    && rawLastReview > ANKI_DUE_TIMESTAMP_THRESHOLD
    ? rawLastReview
    : null;
  return [stability !== null && difficulty !== null ? [stability, difficulty] : null, lastReview];
}

/** 是否携带真实复习进度：全新卡不注入元数据，保持 extraFields 干净。 */
export function hasReviewProgress(sched: CardSchedState): boolean {
  return sched.cardType !== 0 || sched.reps > 0 || sched.ivl > 0 || sched.lapses > 0 || sched.queue < 0;
}

export function parseCollectionDatabase(
  runtime: ApkgImportRuntime,
  collectionPath: string,
  maxMaterializedCardBytes: number,
  mediaPaths: ReadonlyMap<string, string>,
  modernSchema: boolean,
): ParsedPackage {
  let db: DatabaseHandle;
  try {
    db = runtime.openDatabase(collectionPath);
  } catch (error) {
    throw validationError(
      APKG_ERROR_COLLECTION_INVALID,
      `Failed to open APKG collection as read-only SQLite: ${errorMessage(error)}`,
    );
  }

  try {
    try {
      prepareReadOnlyCollection(db);
    } catch (error) {
      throw collectionSqlError(error);
    }

    const warnings: string[] = [];
    let models: Map<number, ModelDefinition>;
    let templateCandidates: TemplateImportCandidate[];
    let deckNames: string[];
    try {
      if (modernSchema) {
        validateModernCollectionSchema(db);
        models = loadModernModels(db, warnings);
        deckNames = loadModernDeckNamesForDisplay(db);
        // 现代 notetypes.config 不携带 deepStudentTemplateId，不臆造模板身份。
        templateCandidates = [];
      } else {
        validateCollectionSchema(db);
        const metadata = readLegacyCollectionMetadata(db);
        if (byteLen(metadata.models) > MAX_MODELS_JSON_BYTES || byteLen(metadata.decks) > MAX_DECKS_JSON_BYTES) {
          throw limitError('APKG model or deck metadata is too large');
        }
        const parsed = parseModels(metadata.models);
        models = parsed.models;
        templateCandidates = parsed.templateCandidates;
        deckNames = parseDeckNames(metadata.decks);
      }

      const cardCount = countCollectionCards(db);
      if (cardCount <= 0) {
        throw validationError(APKG_ERROR_COLLECTION_INVALID, 'APKG collection contains no cards');
      }
      if (cardCount > MAX_CARDS) {
        throw limitError(`APKG collection contains more than ${MAX_CARDS} cards`);
      }

      // 调度列在真实 Anki 包中始终存在；缺失时（极简合成包）静默退化为不读取调度信息。
      const cardsColumns = listCardsTableColumnNames(db);
      const cardsColumnSet = new Set(cardsColumns);
      const hasSchedColumns = ['type', 'queue', 'due', 'ivl', 'factor', 'reps', 'lapses']
        .every((column) => cardsColumnSet.has(column));
      let hasCardData = false;
      if (hasSchedColumns) hasCardData = cardsTableHasColumn(db, 'data');
      const hasNoteData = notesTableHasDataColumn(db);

      const cards: ParsedCard[] = [];
      let materializedBytes = 0;
      let joinedCardRows = 0;
      let schedMetadataCards = 0;
      let currentGroup: PendingNoteGroup | null = null;

      const iterator = iterateLegacyCollectionCards(db, {
        hasSchedColumns,
        hasCardData,
        hasNoteData,
      });
      try {
        for (const rawRow of iterator) {
          const row = rawRow as unknown as Record<string, unknown>;
          joinedCardRows += 1;
          const cardId = readRowNumber(row, 'card_id');
          const noteId = readRowNumber(row, 'note_id');
          const deckId = readRowNumber(row, 'deck_id');
          const cardOrd = readRowNumber(row, 'card_ord');
          const modelId = readRowNumber(row, 'model_id');
          const model = models.get(modelId);
          if (model === undefined) {
            throw validationError(
              APKG_ERROR_COLLECTION_INVALID,
              `APKG card references missing model ${modelId}`,
            );
          }

          const sameGroup = currentGroup !== null
            && currentGroup.modelId === modelId
            && currentGroup.noteId === noteId;
          // Deep Student Cloze 折叠：同 note 其余 card 行直接跳过（不计材料化预算）。
          if (sameGroup && currentGroup!.collapseClozeOrds) continue;
          if (!sameGroup) {
            if (currentGroup !== null) {
              const group = currentGroup;
              currentGroup = null;
              flushNoteGroup(models, group, mediaPaths, cards, warnings, (count) => {
                schedMetadataCards += count;
              }, runtime.logger);
            }
            const rawTags = readRowText(row, 'tags');
            const rawFields = readRowText(row, 'flds');
            const noteData = readRowText(row, 'note_data');
            const scope = parseNoteCardScope(noteData);
            const collapseClozeOrds = model.modelType === 1
              && (scope === 'card' ? false : scope === 'note' ? true : model.collapseClozeOrds);
            currentGroup = {
              modelId,
              noteId,
              rawTags,
              rawFields,
              collapseClozeOrds,
              rows: [],
            };
          }

          let sched: CardSchedState | null = null;
          if (hasSchedColumns) {
            let fsrsMemory: readonly [number, number] | null = null;
            let lastReviewSecs: number | null = null;
            if (hasCardData) {
              const cardData = readRowOptionalText(row, 'card_data');
              if (cardData !== null) {
                const parsed = parseCardFsrsData(cardData);
                fsrsMemory = parsed[0];
                lastReviewSecs = parsed[1];
              }
            }
            sched = {
              cardType: readRowNumber(row, 'sched_type'),
              queue: readRowNumber(row, 'sched_queue'),
              due: readRowNumber(row, 'sched_due'),
              ivl: readRowNumber(row, 'sched_ivl'),
              factor: readRowNumber(row, 'sched_factor'),
              reps: readRowNumber(row, 'sched_reps'),
              lapses: readRowNumber(row, 'sched_lapses'),
              fsrsMemory,
              lastReviewSecs,
            };
          }

          const group = currentGroup!;
          // 预算估算逐行进行（与旧行为一致，保守计费；去重跳过的行也已计入）。
          materializedBytes += validateAndEstimateCard(model, group.rawTags, group.rawFields);
          if (materializedBytes > maxMaterializedCardBytes) {
            throw limitError(
              `APKG materialized card data exceeds the ${maxMaterializedCardBytes} byte limit`,
            );
          }
          group.rows.push({ cardId, cardOrd, deckId, sched });
        }
      } finally {
        (iterator as Iterator<LegacyCollectionCardRow> & { return?: () => void }).return?.();
      }
      if (currentGroup !== null) {
        const group = currentGroup;
        currentGroup = null;
        flushNoteGroup(models, group, mediaPaths, cards, warnings, (count) => {
          schedMetadataCards += count;
        }, runtime.logger);
      }
      if (joinedCardRows !== cardCount) {
        throw validationError(
          APKG_ERROR_COLLECTION_INVALID,
          `APKG has ${cardCount} card rows but only ${joinedCardRows} rows reference valid notes`,
        );
      }
      // col.crt 在 legacy 与现代 schema 中均存在；读取失败（极简合成包）时退化为立即到期。
      let collectionCrtSecs: number | null = null;
      try {
        const crt = readCollectionCrt(db);
        if (crt !== undefined && crt !== null && crt > 0) collectionCrtSecs = crt;
      } catch {
        collectionCrtSecs = null;
      }
      if (schedMetadataCards > 0) {
        warnings.push(
          `已将 ${schedMetadataCards} 张卡片的 Anki 复习进度保存为卡片元数据（AnkiSchedType/AnkiIvl/AnkiReps 等），再导出 APKG 时会回写调度信息`,
        );
      }

      return {
        cards,
        deckNames,
        mediaSkipped: 0,
        mediaImported: 0,
        mediaReport: emptyApkgMediaReport(),
        templateCandidates,
        warnings,
        collectionCrtSecs,
      };
    } catch (error) {
      if (isAppErrorValue(error)) throw error;
      throw collectionSqlError(error);
    }
  } finally {
    try {
      runtime.closeDatabase(db);
    } catch (error) {
      runtime.logger.warn(`[apkg_import] 关闭集合库句柄失败: ${errorMessage(error)}`);
    }
  }
}

function parseNoteCardScope(noteData: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(noteData) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const scope = (value as Record<string, unknown>).deepStudentCardScope;
  return typeof scope === 'string' ? scope : undefined;
}

/**
 * 落地一个 note 分组：
 * - 单行 / Cloze（外部多挖空）/ Deep Student 模板卡：逐行导入；
 * - 外部非 Cloze 模型多行时：两张卡且 ord=0/1 → 视为 “Basic (and reversed card)”，
 *   第二张交换正反面；其他组合 → 按 note 去重保留最小 ord 并写入 warning。
 */
function flushNoteGroup(
  models: ReadonlyMap<number, ModelDefinition>,
  group: PendingNoteGroup,
  mediaPaths: ReadonlyMap<string, string>,
  cards: ParsedCard[],
  warnings: string[],
  onSchedMetadata: (count: number) => void,
  logger: AnkiLogger,
): void {
  const model = models.get(group.modelId);
  if (model === undefined) {
    throw validationError(
      APKG_ERROR_COLLECTION_INVALID,
      `APKG card references missing model ${group.modelId}`,
    );
  }
  const rows = group.rows;
  if (rows.length === 0) return;

  const pushCard = (row: PendingCardRow, swapFrontBack: boolean): void => {
    const card = mapCard(
      model,
      group.rawTags,
      group.rawFields,
      group.noteId,
      row.cardId,
      row.cardOrd,
      row.deckId,
      group.modelId,
      mediaPaths,
      logger,
    );
    card.extraFields.AnkiCardScope = group.collapseClozeOrds ? 'note' : 'card';
    if (swapFrontBack) {
      const front = card.front;
      card.front = card.back;
      card.back = front;
    }
    card.ankiSched = row.sched;
    if (row.sched !== null && hasReviewProgress(row.sched)) {
      // 键名与 ANKI_SCHED_METADATA_KEYS / 导出端 card_sched_restore 保持一致
      const sched = row.sched;
      const values: Array<[string, number]> = [
        ['AnkiSchedType', sched.cardType],
        ['AnkiQueue', sched.queue],
        ['AnkiDue', sched.due],
        ['AnkiIvl', sched.ivl],
        ['AnkiFactor', sched.factor],
        ['AnkiReps', sched.reps],
        ['AnkiLapses', sched.lapses],
      ];
      for (const [key, value] of values) card.extraFields[key] = String(value);
      onSchedMetadata(1);
    }
    cards.push(card);
  };

  const externalNonCloze = model.templateId === null && model.modelType !== 1 && !model.collapseClozeOrds;
  if (rows.length === 1 || !externalNonCloze) {
    for (const row of rows) pushCard(row, false);
    return;
  }

  rows.sort((left, right) => left.cardOrd - right.cardOrd || left.cardId - right.cardId);
  if (rows.length === 2 && rows[0]!.cardOrd === 0 && rows[1]!.cardOrd === 1) {
    pushCard(rows[0]!, false);
    pushCard(rows[1]!, true);
    return;
  }

  pushCard(rows[0]!, false);
  warnings.push(
    `外部多模板笔记 ${group.noteId} 含 ${rows.length} 张卡片，已按笔记去重保留 ord=${rows[0]!.cardOrd}（其余卡片跳过，避免重复卡）`,
  );
}

