/**
 * `anki` 服务：本 lane 对外暴露的模板与 AnkiConnect 能力
 * （`dstu-anki/src/anki/mod.rs`、`anki_connect_service.rs` 的公开函数）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type {
  AnkiAgentLibraryCardRecord,
  AnkiAgentLibraryListRequest,
  AnkiAgentLibraryListResult,
  AnkiAgentLibraryPage,
  AnkiAgentLibraryPageRequest,
  AnkiApkgExporter,
  AnkiApkgImporter,
  AnkiApkgVfs,
  AnkiCardRepository,
  AnkiCardVersionUpdate,
  AnkiChatBlockStore,
  AnkiConnectSyncOptions,
  AnkiDetailedSyncInput,
  AnkiDocumentPipeline,
  AnkiDocumentTaskRepository,
  AnkiLibraryCardDeleteOutcome,
  AnkiLibraryCardVersionUpdate,
  AnkiPreferenceMemory,
  AnkiService,
  AnkiSettingsStore,
  AnkiTemplateService,
  TemplateConfig,
} from '../api.ts';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { AnkiSyncReport, CustomAnkiTemplate } from '../../../../contracts/ipc/generated/L16-anki.ts';
import * as ankiConnect from './anki-connect.ts';
import { addNotesToAnkiDetailed, templateModelName } from './anki-sync.ts';
import { writeAnkiExportReceipts } from '../repository/anki-review-state.ts';
import { readAnkiConnectSyncOptions } from './settings-owner.ts';
import { createAnkiDocumentPipeline } from './document-pipeline.ts';
import { nowRfc3339 } from './time.ts';
import { writeJsonToTemp } from './files.ts';
import { decodeTemplateRow } from './templates.ts';
import { createAnkiTemplates } from './template-service.ts';
import { getTemplateById } from '../repository/templates.ts';
import {
  deleteAnkiCardForLibrary,
  listAnkiLibraryCardsFiltered,
  updateAnkiCardIfVersionForLibrary as updateLibraryCardRow,
} from '../repository/anki-cards.ts';
import { getLibraryCardsByIds, insertCard } from '../repository/chatanki-surface.ts';
import { listAnkiAgentLibraryPage } from '../repository/anki-agent-library.ts';
import { decodeAnkiLibraryCardRow } from './library.ts';
import { getLibraryCardRecord } from '../repository/anki-library.ts';
import { requireFsrsTransactionOwner } from './fsrs-owner.ts';
import {
  consolidateObservation,
  retrievePreferencePrompt,
  type ConsolidateOutcome,
  type PreferenceStore,
  type SessionObservation,
} from './preference-memory.ts';
import {
  createAnkiApkgExporter,
  createAnkiApkgImporter,
  createAnkiApkgVfs,
  createAnkiCards,
  createAnkiChatBlocks,
  createAnkiDocuments,
  createAnkiPreferenceMemory,
  createAnkiSettings,
  type AnkiHostAdaptersOptions,
} from './chatanki-service-adapters.ts';
import type { AnkiLogger } from './logger.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  tombstoneInsightProjectionCardWithConn,
  upsertInsightProjectionTaskWithConn,
  writeInsightProjectionCardWithConn,
  type InsightProjectionCardWrite,
  type InsightProjectionTaskUpsert,
} from '../repository/insight-projection.ts';

/** 服务方法抛出的错误值：对应 Rust `Err(String)`。 */
export class AnkiServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnkiServiceError';
  }
}

export type AnkiHostServiceOptions = AnkiHostAdaptersOptions;

export class AnkiHostService extends Service implements AnkiService {
  private readonly _options: AnkiHostServiceOptions;
  readonly cards: AnkiCardRepository;
  readonly documents: AnkiDocumentTaskRepository;
  readonly chatBlocks: AnkiChatBlockStore;
  readonly settings: AnkiSettingsStore;
  readonly preferenceMemory: AnkiPreferenceMemory;
  readonly apkgImporter: AnkiApkgImporter;
  readonly apkgExporter: AnkiApkgExporter;
  readonly apkgVfs: AnkiApkgVfs;
  readonly templates: AnkiTemplateService;
  readonly pipeline: AnkiDocumentPipeline;

  constructor(ctx: Context, options: AnkiHostServiceOptions) {
    super(ctx, 'anki');
    this._options = options;
    this.templates = createAnkiTemplates({ db: options.db, now: this._now, logger: options.logger });
    this.cards = createAnkiCards(options);
    this.documents = createAnkiDocuments(options);
    this.chatBlocks = createAnkiChatBlocks(ctx);
    this.settings = createAnkiSettings(ctx);
    this.preferenceMemory = createAnkiPreferenceMemory();
    this.apkgImporter = createAnkiApkgImporter(options);
    this.apkgExporter = createAnkiApkgExporter(options);
    this.apkgVfs = createAnkiApkgVfs(ctx);
    this.pipeline = createAnkiDocumentPipeline(ctx, options.db);
  }

  insertAnkiCard(card: AnkiCard): boolean {
    return insertCard(this._options.db(), card);
  }

  listAnkiAgentLibraryCards(
    request: AnkiAgentLibraryListRequest,
    nowMs = Date.now(),
  ): AnkiAgentLibraryListResult {
    const page = Math.max(1, request.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, request.pageSize ?? 12));
    return listAnkiLibraryCardsFiltered(
      this._options.db(),
      request.templateId ?? null,
      request.search ?? null,
      request.filter ?? {},
      page,
      pageSize,
      nowMs,
    );
  }

  listAnkiAgentLibraryPage(
    request: AnkiAgentLibraryPageRequest,
    nowMs: number | bigint = Date.now(),
  ): AnkiAgentLibraryPage {
    return listAnkiAgentLibraryPage(this._options.db(), request, nowMs);
  }

  getAnkiAgentLibraryCard(cardId: string, nowMs = Date.now()): AnkiAgentLibraryCardRecord | null {
    const id = cardId.trim();
    if (id === '') throw new AnkiServiceError('cardId is required');
    const row = getLibraryCardRecord(this._options.db(), id, nowMs);
    if (row === undefined) return null;
    return {
      libraryCard: decodeAnkiLibraryCardRow(row),
      locator: { documentId: row.document_id, sourceSessionId: row.source_session_id },
    };
  }

  updateAnkiCardIfVersionForLibrary(
    card: AnkiCard,
    expectedVersion: string,
    nowMs = Date.now(),
  ): AnkiLibraryCardVersionUpdate {
    const result = updateLibraryCardRow(this._options.db(), card, expectedVersion, nowMs);
    if (result.type === 'updated') {
      return { type: 'updated', current: decodeAnkiLibraryCardRow(result.current) };
    }
    if (result.type === 'conflict') {
      return { type: 'conflict', current: decodeAnkiLibraryCardRow(result.current) };
    }
    return result;
  }

  updateAnkiCardIfVersionForSession(
    card: AnkiCard,
    expectedVersion: string,
    sessionId: string,
  ): AnkiCardVersionUpdate {
    return this.cards.updateCardIfVersionForSession(card, expectedVersion, sessionId);
  }

  getAnkiAgentLibraryCardsByIds(cardIds: readonly string[]): AnkiCard[] {
    return getLibraryCardsByIds(this._options.db(), cardIds);
  }

  deleteAnkiCardForLibrary(
    cardId: string,
    expectedVersion: string,
    expectedReviewVersion: number | bigint | null,
    nowMs = Date.now(),
  ): AnkiLibraryCardDeleteOutcome {
    return deleteAnkiCardForLibrary(
      this._options.db(),
      requireFsrsTransactionOwner(this.ctx),
      cardId,
      expectedVersion,
      expectedReviewVersion,
      nowMs,
    );
  }

  getCustomTemplateById(templateId: string): CustomAnkiTemplate | null {
    const row = getTemplateById(this._options.db(), templateId);
    return row === undefined ? null : decodeTemplateRow(row, this._now);
  }

  /** `dstu-anki/src/anki/mod.rs:10-29`：模板不存在/读取失败都是 `Err(String)`。 */
  getTemplateConfig(templateId: string): TemplateConfig {
    let row;
    try {
      row = getTemplateById(this._options.db(), templateId);
    } catch (error) {
      throw new AnkiServiceError(`获取模板失败: ${(error as Error).message}`);
    }
    if (row === undefined) throw new AnkiServiceError(`模板不存在: ${templateId}`);
    const template = decodeTemplateRow(row, this._now);
    return [template.name, template.fields, template.front_template, template.back_template, template.css_style];
  }

  checkAnkiConnectAvailability(): Promise<boolean> {
    return ankiConnect.checkAnkiConnectAvailability(this._options.logger);
  }

  getDeckNames(): Promise<string[]> {
    return ankiConnect.getDeckNames();
  }

  getModelNames(): Promise<string[]> {
    return ankiConnect.getModelNames();
  }

  createDeckIfNotExists(deckName: string): Promise<void> {
    return ankiConnect.createDeckIfNotExists(deckName);
  }

  templateModelName(template: Pick<CustomAnkiTemplate, 'id' | 'version'>): string {
    return templateModelName(template);
  }

  syncOptionsFromSettings(
    batchSize: string | null,
    retryTimes: string | null,
    mediaMode: string | null,
  ): AnkiConnectSyncOptions {
    return ankiConnect.syncOptionsFromSettings(batchSize, retryTimes, mediaMode);
  }

  readSyncOptions(): AnkiConnectSyncOptions {
    return readAnkiConnectSyncOptions(this.ctx, this._options.db());
  }

  addNotesToAnkiDetailed(input: AnkiDetailedSyncInput): Promise<AnkiSyncReport> {
    return addNotesToAnkiDetailed(input, this._options.logger);
  }

  writeAnkiExportReceipts(
    cardIds: readonly string[],
    noteIds: readonly (number | null)[],
    exportedAt = nowRfc3339(),
  ): number {
    return writeAnkiExportReceipts(this._options.db(), cardIds, noteIds, exportedAt);
  }

  /** `anki_preference_memory.rs::consolidate_observation`。 */
  consolidatePreferenceObservation(
    store: PreferenceStore,
    observation: SessionObservation,
    nowMs: number | bigint,
  ): ConsolidateOutcome {
    return consolidateObservation(store, observation, nowMs);
  }

  /** `anki_preference_memory.rs::retrieve_preference_prompt`。 */
  retrievePreferencePrompt(
    store: PreferenceStore,
    goal: string,
    availableTemplates: readonly string[],
    maxTokens: number,
  ): string {
    return retrievePreferencePrompt(store, goal, availableTemplates, maxTokens);
  }

  /** `src/cmd/anki_connect.rs:2145-2159`。 */
  async saveJsonFile(content: string, suggestedName: string): Promise<string> {
    try {
      return await writeJsonToTemp(this._options.tempDir, content, suggestedName);
    } catch (error) {
      throw new AnkiServiceError((error as Error).message);
    }
  }

  tombstoneInsightProjectionCardWithConn(conn: SqlExecutor, cardId: string, now: string): void {
    tombstoneInsightProjectionCardWithConn(conn, cardId, now);
  }

  upsertInsightProjectionTaskWithConn(conn: SqlExecutor, task: InsightProjectionTaskUpsert): void {
    upsertInsightProjectionTaskWithConn(conn, task);
  }

  writeInsightProjectionCardWithConn(
    conn: SqlExecutor,
    card: InsightProjectionCardWrite,
  ): 'updated' | 'inserted' {
    return writeInsightProjectionCardWithConn(conn, card);
  }

  private readonly _now = (): Date => this._options.now?.() ?? new Date();
}
