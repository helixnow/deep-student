import type { Context } from '@deepseek-ai/cordis';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { LlmRawPrompt } from '../../llm/api.ts';
import type { QbankService } from '../../qbank/api.ts';
import type { Question, VfsReposService } from '../../vfs-repos/api.ts';
import type { MasteryService } from '../api.ts';
import * as examSprintRepo from '../repository/exam-sprint.ts';
import { loadSchedulerConfig } from '../repository/fsrs.ts';
import { eventConcept, recomputeStateWithConn, tombstone } from '../repository/mastery.ts';
import { utcNow } from './clock.ts';
import { appError, errorText } from './errors.ts';
import {
  DEFAULT_BASE_TARGET_RETENTION,
  compressIntervalForExamHorizon,
  computeDaysUntilExam,
  computeEffectiveTargetRetention,
  interleaveSprintQueue,
  logicalLocalDateKey,
  parseExamDateYmd,
  runExamHorizonTriage,
  sanitizeBaseTargetRetention,
  sanitizeRolloverHour,
  sanitizeSprintBudgetMinutes,
  type BuildDailySprintRequest,
  type ClientMindmapReciteSignal,
  type ConceptMasteryDelta,
  type DailySprintPlan,
  type ExamHorizonConfig,
  type ExamHorizonConfigPatch,
  type ExamReadinessSnapshot,
  type FsrsTriageCandidate,
  type GenerateMistakeVariantRequest,
  type GenerateMistakeVariantResult,
  type GetExamReadinessRequest,
  type MindmapTriageCandidate,
  type MistakeTriageCandidate,
  type SettleSprintSessionRequest,
  type SprintMindmapBlankRange,
  type SprintMistakeItem,
  type SprintQueueItem,
  type SprintSessionSettlement,
  type SprintSourceAnchor,
  type TriageCandidateInput,
} from './examHorizonScheduler.ts';
import { buildFsrsChangedPayloadAfterWrite } from './fsrs-events.ts';
import { logicalDayBoundsMs } from './fsrs-scheduler.ts';
import { DEFAULT_DECK_ID, MS_PER_DAY } from './fsrs-types.ts';
import { localDateKey } from './local-date.ts';
import {
  MistakeVariantGenerator,
  resolveVariantEligibility,
  type MistakeQuestionRecord,
} from './mistakeVariantGenerator.ts';
import { FsrsReviewService } from './review.ts';
import { ReviewPlanService, defaultReviewPlanConfig } from './review-plan.ts';
import type { ReviewPlan } from './review-plan-types.ts';
import { studyTimeAdd } from './study-time.ts';

export interface RemoteCallMeta {
  signal?: AbortSignal;
}

const FULLWIDTH_CLOZE_MASK = '［ ？ ］';
const MAX_MINDMAPS_TO_HARVEST = 30;
const MAX_MINDMAP_NODES_TO_HARVEST = 500;
const MAX_SIBLING_HINTS = 4;
const MAX_SIBLING_HINT_CHARS = 36;
const MAX_CONCEPT_KEY_CHARS = 64;
const CLOZE_RE = /\{\{c\d+::/i;
const EXAM_TAG_RE = /(?:^|#|\s)(?:exam|重点|必考|核心|high[-_]?yield)(?:$|\s)/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableTrimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxChars - 1))}…`;
}

function round1(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function round4(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function parseYmdUtcDayNumber(value: string | null | undefined): number | null {
  const parsed = parseExamDateYmd(value);
  if (parsed === null) return null;
  return Math.floor(Date.UTC(parsed.year, parsed.month - 1, parsed.day) / MS_PER_DAY);
}

function sanitizeWireJsonValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(sanitizeWireJsonValue);
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        out[key] = sanitizeWireJsonValue(item);
      }
    }
    return out;
  }
  return null;
}

function normalizeAnchorKind(rawKind: string): SprintSourceAnchor['kind'] | null {
  const lower = rawKind.trim().toLowerCase();
  if (lower === 'pdf' || lower === 'epub' || lower === 'textbook' || lower === 'file') return 'pdf';
  if (lower === 'media' || lower === 'video' || lower === 'audio' || lower === 'bilibili') {
    return 'media';
  }
  if (lower === 'note' || lower === 'markdown') return 'note';
  if (lower === 'mindmap') return 'mindmap';
  if (lower === 'qbank' || lower === 'question' || lower === 'exam') return 'qbank';
  return null;
}

function parseDsAnchorUri(
  uri: string,
  fallbackLabel: string | null = null,
): SprintSourceAnchor | null {
  const trimmed = uri.trim();
  if (!trimmed.startsWith('ds-anchor://v1/')) return null;
  const rest = trimmed.slice('ds-anchor://v1/'.length);
  const qIndex = rest.indexOf('?');
  const pathPart = qIndex >= 0 ? rest.slice(0, qIndex) : rest;
  const queryPart = qIndex >= 0 ? rest.slice(qIndex + 1) : '';
  const segments = pathPart.split('/').filter((seg) => seg.length > 0);
  if (segments.length < 2) return null;

  const kind = normalizeAnchorKind(segments[0]!);
  if (kind === null) return null;
  let resourceId: string;
  try {
    resourceId = decodeURIComponent(segments[1]!);
  } catch {
    resourceId = segments[1]!;
  }
  if (resourceId.trim().length === 0) return null;

  let page: number | null = null;
  let startMs: number | null = null;
  let blockId: string | null = null;
  let nodeId: string | null = null;
  let questionId: string | null = null;
  let quote: string | null = null;
  let label = fallbackLabel;

  if (queryPart.length > 0) {
    const params = new URLSearchParams(queryPart);
    const pRaw = params.get('page') ?? params.get('p');
    if (pRaw !== null && Number.isFinite(Number(pRaw))) {
      page = Math.max(1, Math.trunc(Number(pRaw)));
    }
    const msRaw = params.get('startMs') ?? params.get('t') ?? params.get('ms');
    if (msRaw !== null && Number.isFinite(Number(msRaw))) {
      startMs = Math.max(0, Math.trunc(Number(msRaw)));
    }
    blockId = nullableTrimmed(params.get('block') ?? params.get('blockId'));
    nodeId = nullableTrimmed(params.get('node') ?? params.get('nodeId'));
    questionId = nullableTrimmed(params.get('question') ?? params.get('questionId'));
    quote = nullableTrimmed(params.get('quote'));
    label = nullableTrimmed(params.get('label')) ?? label;
  }

  return {
    anchorUri: trimmed,
    kind,
    resourceId,
    label,
    page,
    startMs,
    blockId,
    nodeId,
    questionId,
    quote,
  };
}

function anchorFromOutboundEdge(
  edge: examSprintRepo.OutboundAnchorEdgeRow,
): SprintSourceAnchor | null {
  if (edge.targetAnchorUri !== null) {
    const parsed = parseDsAnchorUri(edge.targetAnchorUri, edge.sourceLabel);
    if (parsed !== null) {
      return {
        ...parsed,
        page: parsed.page ?? edge.targetPage,
        startMs: parsed.startMs ?? edge.targetStartMs,
        label: parsed.label ?? edge.sourceLabel,
      };
    }
  }
  const kind = normalizeAnchorKind(edge.targetKind);
  if (kind === null) return null;
  return {
    anchorUri: edge.targetAnchorUri,
    kind,
    resourceId: edge.targetResourceId,
    label: edge.sourceLabel,
    page: edge.targetPage,
    startMs: edge.targetStartMs,
    blockId: null,
    nodeId: null,
    questionId: null,
    quote: null,
  };
}

function detectCardFormat(
  front: string,
  text: string | null,
  fields: Record<string, string>,
  templateId: string | null,
): 'qa' | 'cloze' | 'image_occlusion' {
  const hasOcclusionField =
    (typeof fields.ImageOcclusion === 'string' && fields.ImageOcclusion.trim().length > 0) ||
    (typeof fields.OcclusionMasks === 'string' && fields.OcclusionMasks.trim().length > 0) ||
    (typeof fields.Masks === 'string' &&
      typeof fields.Image === 'string' &&
      fields.Masks.trim().length > 0);
  if (
    hasOcclusionField ||
    front.includes('data-occlusion') ||
    (templateId !== null && templateId.toLowerCase().includes('occlusion'))
  ) {
    return 'image_occlusion';
  }
  const textField = fields.Text ?? text ?? '';
  if (CLOZE_RE.test(front) || CLOZE_RE.test(textField)) {
    return 'cloze';
  }
  return 'qa';
}

function resolveFsrsCardSourceAnchor(
  vfsDb: SqlExecutor | null,
  card: examSprintRepo.HydratedAnkiSprintCard,
  debug: (message: string) => void,
): SprintSourceAnchor | null {
  const edge = examSprintRepo.readOutboundAnchorForSource(
    vfsDb,
    'flashcard',
    card.ankiCardId,
    '',
    debug,
  );
  if (edge !== null) {
    const resolved = anchorFromOutboundEdge(edge);
    if (resolved !== null) return resolved;
  }

  const fieldUri =
    nullableTrimmed(card.extraFields.SourceAnchorUri) ??
    nullableTrimmed(card.extraFields.source_anchor_uri);
  if (fieldUri !== null) {
    const parsed = parseDsAnchorUri(fieldUri, card.originalDocumentName);
    if (parsed !== null) return parsed;
  }

  if (card.sourceRefJson !== null) {
    try {
      const parsedRef: unknown = JSON.parse(card.sourceRefJson);
      if (typeof parsedRef === 'string') {
        const fromUri = parseDsAnchorUri(parsedRef, card.originalDocumentName);
        if (fromUri !== null) return fromUri;
      } else if (isPlainRecord(parsedRef)) {
        const uriCandidate = nullableTrimmed(
          typeof parsedRef.anchorUri === 'string'
            ? parsedRef.anchorUri
            : typeof parsedRef.anchor_uri === 'string'
              ? parsedRef.anchor_uri
              : null,
        );
        if (uriCandidate !== null) {
          const fromUri = parseDsAnchorUri(uriCandidate, card.originalDocumentName);
          if (fromUri !== null) return fromUri;
        }
        const rawResId = nullableTrimmed(
          typeof parsedRef.resourceId === 'string'
            ? parsedRef.resourceId
            : typeof parsedRef.source_id === 'string'
              ? parsedRef.source_id
              : null,
        );
        const rawKind = nullableTrimmed(
          typeof parsedRef.kind === 'string'
            ? parsedRef.kind
            : typeof parsedRef.type === 'string'
              ? parsedRef.type
              : null,
        );
        if (rawResId !== null && rawKind !== null) {
          const normalizedKind = normalizeAnchorKind(rawKind);
          if (normalizedKind !== null) {
            const pageVal =
              typeof parsedRef.page === 'number' && Number.isFinite(parsedRef.page)
                ? Math.max(1, Math.trunc(parsedRef.page))
                : null;
            const startMsVal =
              typeof parsedRef.startMs === 'number' && Number.isFinite(parsedRef.startMs)
                ? Math.max(0, Math.trunc(parsedRef.startMs))
                : null;
            return {
              anchorUri: null,
              kind: normalizedKind,
              resourceId: rawResId,
              label: card.originalDocumentName,
              page: pageVal,
              startMs: startMsVal,
              blockId: nullableTrimmed(
                typeof parsedRef.blockId === 'string' ? parsedRef.blockId : null,
              ),
              nodeId: null,
              questionId: null,
              quote: nullableTrimmed(typeof parsedRef.quote === 'string' ? parsedRef.quote : null),
            };
          }
        }
      }
    } catch (error) {
      debug(`[exam-sprint] card source_ref parse skipped for ${card.ankiCardId}: ${errorText(error)}`);
    }
  }

  const candidateId = card.sourceId ?? card.documentId;
  const sourceType = card.sourceType?.toLowerCase() ?? '';
  if (sourceType === 'note' || candidateId.startsWith('note_')) {
    return {
      anchorUri: `ds-anchor://v1/note/${encodeURIComponent(candidateId)}`,
      kind: 'note',
      resourceId: candidateId,
      label: card.originalDocumentName,
      page: null,
      startMs: null,
      blockId: null,
      nodeId: null,
      questionId: null,
      quote: null,
    };
  }
  if (sourceType === 'pdf' || sourceType === 'textbook' || candidateId.startsWith('tb_')) {
    return {
      anchorUri: `ds-anchor://v1/pdf/${encodeURIComponent(candidateId)}`,
      kind: 'pdf',
      resourceId: candidateId,
      label: card.originalDocumentName,
      page: null,
      startMs: null,
      blockId: null,
      nodeId: null,
      questionId: null,
      quote: null,
    };
  }
  if (sourceType === 'mindmap' || candidateId.startsWith('mm_')) {
    return {
      anchorUri: `ds-anchor://v1/mindmap/${encodeURIComponent(candidateId)}`,
      kind: 'mindmap',
      resourceId: candidateId,
      label: card.originalDocumentName,
      page: null,
      startMs: null,
      blockId: null,
      nodeId: null,
      questionId: null,
      quote: null,
    };
  }
  if (sourceType === 'media' || candidateId.startsWith('att_')) {
    return {
      anchorUri: `ds-anchor://v1/media/${encodeURIComponent(candidateId)}`,
      kind: 'media',
      resourceId: candidateId,
      label: card.originalDocumentName,
      page: null,
      startMs: null,
      blockId: null,
      nodeId: null,
      questionId: null,
      quote: null,
    };
  }

  return null;
}

function resolveQuestionSourceAnchor(
  vfsDb: SqlExecutor | null,
  question: Question,
  examName: string | null,
  debug: (message: string) => void,
): SprintSourceAnchor | null {
  const edge = examSprintRepo.readOutboundAnchorForSource(
    vfsDb,
    'qbank',
    question.id,
    '',
    debug,
  );
  if (edge !== null) {
    const resolved = anchorFromOutboundEdge(edge);
    if (resolved !== null) return resolved;
  }

  if (Array.isArray(question.source_refs) && question.source_refs.length > 0) {
    const firstRef = question.source_refs[0]!;
    const srcId = nullableTrimmed(firstRef.source_id);
    if (srcId !== null) {
      const kind: SprintSourceAnchor['kind'] = srcId.startsWith('note_')
        ? 'note'
        : srcId.startsWith('mm_')
          ? 'mindmap'
          : 'pdf';
      const page =
        firstRef.page !== null && firstRef.page !== undefined && Number.isFinite(firstRef.page)
          ? Math.max(1, Math.trunc(firstRef.page))
          : null;
      const uriPage = page !== null ? `?page=${page}` : '';
      return {
        anchorUri: `ds-anchor://v1/${kind}/${encodeURIComponent(srcId)}${uriPage}`,
        kind,
        resourceId: srcId,
        label: examName,
        page,
        startMs: null,
        blockId: null,
        nodeId: null,
        questionId: question.id,
        quote: null,
      };
    }
  }

  return {
    anchorUri: `ds-anchor://v1/qbank/${encodeURIComponent(question.exam_id)}?question=${encodeURIComponent(question.id)}`,
    kind: 'qbank',
    resourceId: question.exam_id,
    label: examName,
    page: null,
    startMs: null,
    blockId: null,
    nodeId: null,
    questionId: question.id,
    quote: null,
  };
}

function sanitizeAndMergeBlankRanges(
  rawRanges: unknown,
  textLength: number,
): SprintMindmapBlankRange[] {
  if (!Array.isArray(rawRanges) || textLength <= 0) return [];
  const valid: SprintMindmapBlankRange[] = [];
  for (const entry of rawRanges) {
    if (!isPlainRecord(entry)) continue;
    const rawStart = typeof entry.start === 'number' ? Math.trunc(entry.start) : -1;
    const rawEnd = typeof entry.end === 'number' ? Math.trunc(entry.end) : -1;
    const start = Math.max(0, Math.min(textLength, rawStart));
    const end = Math.max(0, Math.min(textLength, rawEnd));
    if (end > start) {
      valid.push({ start, end });
    }
  }
  if (valid.length <= 1) return valid;
  valid.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SprintMindmapBlankRange[] = [valid[0]!];
  for (let i = 1; i < valid.length; i += 1) {
    const prev = merged[merged.length - 1]!;
    const curr = valid[i]!;
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

function computeAutoMaskRange(fullText: string): SprintMindmapBlankRange[] {
  if (fullText.length === 0) return [];
  const delimiters = ['：', ':', '—', '--', '='];
  for (const delim of delimiters) {
    const idx = fullText.indexOf(delim);
    if (idx >= 0) {
      let start = idx + delim.length;
      while (start < fullText.length && /\s/.test(fullText[start]!)) {
        start += 1;
      }
      if (start < fullText.length) {
        return [{ start, end: fullText.length }];
      }
    }
  }
  if (fullText.length <= 4) {
    return [{ start: 0, end: fullText.length }];
  }
  const start = Math.max(1, Math.floor(fullText.length * 0.4));
  return [{ start, end: fullText.length }];
}

function buildMaskedText(fullText: string, ranges: readonly SprintMindmapBlankRange[]): string {
  if (ranges.length === 0) return fullText;
  let cursor = 0;
  const parts: string[] = [];
  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push(fullText.slice(cursor, range.start));
    }
    parts.push(FULLWIDTH_CLOZE_MASK);
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < fullText.length) {
    parts.push(fullText.slice(cursor));
  }
  return parts.join('');
}

interface RawMindmapNodeShape {
  id: string;
  text: string;
  note: string | null;
  href: string | null;
  priority: number | null;
  blankedRanges: SprintMindmapBlankRange[];
  refs: Array<{ sourceId: string; type: string; name: string | null }>;
  children: RawMindmapNodeShape[];
}

function decodeMindmapNode(raw: unknown, budget: { remaining: number }): RawMindmapNodeShape | null {
  if (budget.remaining <= 0) return null;
  if (!isPlainRecord(raw)) return null;
  const id = nullableTrimmed(typeof raw.id === 'string' ? raw.id : null);
  if (id === null) return null;
  budget.remaining -= 1;
  // Blank ranges use offsets into the original text, including its whitespace.
  const text = typeof raw.text === 'string' ? raw.text : '';
  const note = nullableTrimmed(typeof raw.note === 'string' ? raw.note : null);
  const href = nullableTrimmed(typeof raw.href === 'string' ? raw.href : null);
  const priority =
    typeof raw.priority === 'number' && Number.isFinite(raw.priority)
      ? Math.trunc(raw.priority)
      : null;
  const blankedRanges = sanitizeAndMergeBlankRanges(raw.blankedRanges, text.length);

  const refs: Array<{ sourceId: string; type: string; name: string | null }> = [];
  if (Array.isArray(raw.refs)) {
    for (const refEntry of raw.refs) {
      if (!isPlainRecord(refEntry)) continue;
      const sourceId = nullableTrimmed(
        typeof refEntry.sourceId === 'string' ? refEntry.sourceId : null,
      );
      const refType = nullableTrimmed(typeof refEntry.type === 'string' ? refEntry.type : null);
      if (sourceId !== null && refType !== null) {
        refs.push({
          sourceId,
          type: refType,
          name: nullableTrimmed(typeof refEntry.name === 'string' ? refEntry.name : null),
        });
      }
    }
  }

  const children: RawMindmapNodeShape[] = [];
  if (Array.isArray(raw.children)) {
    for (const child of raw.children) {
      if (budget.remaining <= 0) break;
      const decoded = decodeMindmapNode(child, budget);
      if (decoded !== null) children.push(decoded);
    }
  }

  return {
    id,
    text,
    note,
    href,
    priority,
    blankedRanges,
    refs,
    children,
  };
}

function parseMindmapRootNode(rawContent: string | null, nodeLimit: number): RawMindmapNodeShape | null {
  if (rawContent === null || rawContent.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(rawContent);
    if (!isPlainRecord(parsed)) return null;
    const budget = { remaining: nodeLimit };
    if (isPlainRecord(parsed.root)) {
      return decodeMindmapNode(parsed.root, budget);
    }
    return decodeMindmapNode(parsed, budget);
  } catch {
    return null;
  }
}

function normalizeConceptTag(raw: string): string | null {
  const trimmed = rustTrim(raw);
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_CONCEPT_KEY_CHARS
    ? trimmed
    : trimmed.slice(0, MAX_CONCEPT_KEY_CHARS);
}

export function sm2QualityFromSprintRating(rating: 1 | 2 | 3 | 4, passed: boolean): number {
  if (rating === 1) return 1;
  if (!passed) return rating === 2 ? 2 : 1;
  if (rating === 2) return 3;
  if (rating === 3) return 4;
  return 5;
}

export class DailySprintService {
  private readonly ctx: Context;
  private readonly variantGenerator: MistakeVariantGenerator;

  constructor(ctx: Context, variantGenerator?: MistakeVariantGenerator) {
    this.ctx = ctx;
    this.variantGenerator =
      variantGenerator ??
      new MistakeVariantGenerator({
        getVfsDb: () => this.tryVfsDb(),
        getVfsRepos: () => this.tryVfsRepos(),
        getRawPrompt: () => (this.ctx.get('llmRawPrompt') as LlmRawPrompt | undefined) ?? null,
        getQbank: () => (this.ctx.get('qbank') as QbankService | undefined) ?? null,
        debug: (message) => this.ctx.logger('review').debug(message),
      });
  }

  private logger(): ReturnType<Context['logger']> {
    return this.ctx.logger('review');
  }

  private mistakesDb(): DatabaseHandle {
    return this.ctx.storage.database('mistakes');
  }

  private tryVfsDb(): DatabaseHandle | null {
    try {
      return this.ctx.storage.database('vfs');
    } catch (error) {
      this.logger().debug(`[exam-sprint] vfs database unavailable: ${errorText(error)}`);
      return null;
    }
  }

  private tryVfsRepos(): VfsReposService | null {
    return (this.ctx.get('vfsRepo') as VfsReposService | undefined) ?? null;
  }

  private tryMastery(): MasteryService | null {
    return (this.ctx.get('mastery') as MasteryService | undefined) ?? null;
  }

  private fsrsService(): FsrsReviewService {
    const log = this.logger();
    return new FsrsReviewService(
      this.mistakesDb(),
      (msg) => log.warn(msg),
      (msg) => log.info(msg),
      (msg) => log.debug(msg),
    );
  }

  private reviewPlanService(): ReviewPlanService | null {
    const vfsDb = this.tryVfsDb();
    const repos = this.tryVfsRepos();
    if (vfsDb === null || repos === null) return null;
    const log = this.logger();
    return new ReviewPlanService(
      vfsDb,
      repos,
      this.tryMastery(),
      defaultReviewPlanConfig(),
      (msg) => log.warn(msg),
      (msg) => log.info(msg),
    );
  }

  getExamHorizonConfig(
    spaceId: string | null = null,
    _call?: RemoteCallMeta,
  ): ExamHorizonConfig {
    const normalizedSpaceId = nullableTrimmed(spaceId);
    const mistakesDb = this.mistakesDb();
    const vfsDb = this.tryVfsDb();
    const log = this.logger();

    let dayRolloverHour = 4;
    try {
      const scheduler = loadSchedulerConfig(mistakesDb, DEFAULT_DECK_ID, (msg) => log.warn(msg));
      dayRolloverHour = sanitizeRolloverHour(scheduler.dayRolloverHour);
    } catch (error) {
      log.debug(`[exam-sprint] Default deck config fallback: ${errorText(error)}`);
    }

    const profileRow = examSprintRepo.readStudySpaceProfileRow(
      vfsDb,
      normalizedSpaceId,
      (msg) => log.debug(msg),
    );
    const persisted = examSprintRepo.readPersistedExamHorizonEntry(
      mistakesDb,
      normalizedSpaceId,
      (msg) => log.debug(msg),
    );

    const rootFolderId = persisted !== null ? persisted.rootFolderId : (profileRow?.rootFolderId ?? null);
    const rawExamDate = persisted !== null ? persisted.examDate : (profileRow?.examDate ?? null);
    const examDate = parseExamDateYmd(rawExamDate)?.normalized ?? null;
    const sprintBudgetMinutes = sanitizeSprintBudgetMinutes(
      persisted !== null
        ? persisted.sprintBudgetMinutes
        : (profileRow?.dailyBudgetMinutes ?? undefined),
    );
    const baseTargetRetention = sanitizeBaseTargetRetention(
      persisted !== null
        ? persisted.baseTargetRetention
        : (profileRow?.targetRetention ?? DEFAULT_BASE_TARGET_RETENTION),
      profileRow?.targetRetention ?? DEFAULT_BASE_TARGET_RETENTION,
    );
    const defaultDeckId = persisted !== null
      ? persisted.defaultDeckId
      : (profileRow?.defaultDeckId ?? null);

    return {
      spaceId: normalizedSpaceId,
      rootFolderId,
      examDate,
      sprintBudgetMinutes,
      baseTargetRetention,
      defaultDeckId,
      dayRolloverHour,
    };
  }

  updateExamHorizonConfig(
    patch: ExamHorizonConfigPatch,
    _call?: RemoteCallMeta,
  ): ExamHorizonConfig {
    const safePatch: ExamHorizonConfigPatch = isPlainRecord(patch) ? patch : {};
    const spaceId = nullableTrimmed(safePatch.spaceId);
    const current = this.getExamHorizonConfig(spaceId);

    const nextRootFolderId =
      safePatch.rootFolderId !== undefined
        ? nullableTrimmed(safePatch.rootFolderId)
        : current.rootFolderId;
    const nextExamDate =
      safePatch.examDate !== undefined
        ? (parseExamDateYmd(safePatch.examDate)?.normalized ?? null)
        : current.examDate;
    const nextBudget =
      safePatch.sprintBudgetMinutes !== undefined
        ? sanitizeSprintBudgetMinutes(safePatch.sprintBudgetMinutes)
        : current.sprintBudgetMinutes;
    const nextRetention =
      safePatch.baseTargetRetention !== undefined
        ? sanitizeBaseTargetRetention(safePatch.baseTargetRetention, current.baseTargetRetention)
        : current.baseTargetRetention;
    const nextDeckId =
      safePatch.defaultDeckId !== undefined
        ? nullableTrimmed(safePatch.defaultDeckId)
        : current.defaultDeckId;

    const nowRfc = utcNow().rfc;
    examSprintRepo.writePersistedExamHorizonEntry(
      this.mistakesDb(),
      spaceId,
      {
        rootFolderId: nextRootFolderId,
        examDate: nextExamDate,
        sprintBudgetMinutes: nextBudget,
        baseTargetRetention: nextRetention,
        defaultDeckId: nextDeckId,
      },
      nowRfc,
      (msg) => this.logger().debug(msg),
    );

    return this.getExamHorizonConfig(spaceId);
  }

  private resolveEffectiveConfig(
    request: {
      spaceId: string | null;
      rootFolderId?: string | null;
      examDateOverride?: string | null;
      sprintBudgetMinutesOverride?: number | null;
      defaultDeckIdOverride?: string | null;
    },
  ): ExamHorizonConfig {
    const base = this.getExamHorizonConfig(request.spaceId ?? null);
    const rootFolderId =
      request.rootFolderId !== undefined && request.rootFolderId !== null
        ? nullableTrimmed(request.rootFolderId)
        : base.rootFolderId;
    const examDate =
      request.examDateOverride !== undefined && request.examDateOverride !== null
        ? (parseExamDateYmd(request.examDateOverride)?.normalized ?? base.examDate)
        : base.examDate;
    const sprintBudgetMinutes =
      request.sprintBudgetMinutesOverride !== undefined &&
      request.sprintBudgetMinutesOverride !== null
        ? sanitizeSprintBudgetMinutes(request.sprintBudgetMinutesOverride)
        : base.sprintBudgetMinutes;
    const defaultDeckId =
      request.defaultDeckIdOverride !== undefined && request.defaultDeckIdOverride !== null
        ? nullableTrimmed(request.defaultDeckIdOverride)
        : base.defaultDeckId;

    return {
      ...base,
      rootFolderId,
      examDate,
      sprintBudgetMinutes,
      defaultDeckId,
    };
  }

  private lookupConceptMasteryScore(
    conceptTags: readonly string[],
    cache: Map<string, number | null>,
  ): number | null {
    const mastery = this.tryMastery();
    if (mastery === null) return null;
    const primary = conceptTags.map(rustTrim).find((tag) => tag.length > 0);
    if (primary === undefined) return null;
    if (cache.has(primary)) {
      return cache.get(primary) ?? null;
    }
    let score: number | null = null;
    try {
      score = mastery.getState(primary)?.score ?? null;
    } catch (error) {
      this.logger().debug(`[exam-sprint] mastery lookup skipped for ${primary}: ${errorText(error)}`);
      score = null;
    }
    cache.set(primary, score);
    return score;
  }

  private harvestFsrsCandidates(params: {
    config: ExamHorizonConfig;
    nowMs: number;
    nextDayStartMs: number;
    folderScope: examSprintRepo.FolderScopeResourceIds | null;
    masteryCache: Map<string, number | null>;
  }): FsrsTriageCandidate[] {
    const log = this.logger();
    const fsrsSvc = this.fsrsService();
    try {
      fsrsSvc.ensureMemoryStatesCurrent();
    } catch (error) {
      log.warn(`[exam-sprint] FSRS memory state check warning: ${errorText(error)}`);
    }

    const mistakesDb = this.mistakesDb();
    const vfsDb = this.tryVfsDb();
    const rows = examSprintRepo.listActiveFsrsSprintRows(mistakesDb);
    const durations = examSprintRepo.readFsrsHistoricalDurations(
      mistakesDb,
      (msg) => log.debug(msg),
    );

    const deckFilter =
      params.config.defaultDeckId !== null &&
      params.config.defaultDeckId !== DEFAULT_DECK_ID &&
      params.config.defaultDeckId.toLowerCase() !== 'default'
        ? params.config.defaultDeckId
        : null;

    const out: FsrsTriageCandidate[] = [];
    for (const row of rows) {
      const { state, card } = row;
      if (deckFilter !== null) {
        const deckMatches =
          card.deckName === deckFilter ||
          (card.deckName !== null && card.deckName.startsWith(`${deckFilter}::`)) ||
          state.deckId === deckFilter;
        if (!deckMatches) continue;
      }

      const inFolderScope =
        params.folderScope !== null &&
        (params.folderScope.itemIds.has(card.ankiCardId) ||
          (card.sourceId !== null && params.folderScope.itemIds.has(card.sourceId)) ||
          params.folderScope.itemIds.has(card.documentId));
      if (params.config.rootFolderId !== null && !inFolderScope) continue;

      const isBuried = state.buriedUntilMs !== null && state.buriedUntilMs > params.nowMs;
      let isDue = false;
      if (!isBuried && state.state !== 0) {
        if (state.state === 1 || state.state === 3) {
          isDue = state.dueMs <= params.nowMs;
        } else if (state.state === 2) {
          isDue = state.dueMs < params.nextDayStartMs;
        }
      }

      const daysSinceLastReview =
        state.lastReviewMs !== null
          ? Math.max(0, (params.nowMs - state.lastReviewMs) / MS_PER_DAY)
          : Math.max(0, state.elapsedDays);
      const daysOverdue = isDue ? Math.max(0, (params.nowMs - state.dueMs) / MS_PER_DAY) : 0;

      const rawTags = card.tags
        .map(normalizeConceptTag)
        .filter((tag): tag is string => tag !== null);
      const fallbackDocTag =
        rawTags.length === 0 &&
        card.originalDocumentName !== null &&
        card.originalDocumentName.toLowerCase() !== 'default'
          ? normalizeConceptTag(card.originalDocumentName)
          : null;
      const conceptTags =
        rawTags.length > 0 ? rawTags : fallbackDocTag !== null ? [fallbackDocTag] : [];

      const fields: Record<string, string> = { ...card.extraFields };
      if (fields.Front === undefined) fields.Front = card.front;
      if (fields.Back === undefined) fields.Back = card.back;
      if (card.text !== null && fields.Text === undefined) fields.Text = card.text;

      const cardFormat = detectCardFormat(card.front, card.text, fields, card.templateId);
      const hist = durations.get(state.id);
      const conceptMasteryScore = this.lookupConceptMasteryScore(conceptTags, params.masteryCache);
      const sourceAnchor = resolveFsrsCardSourceAnchor(vfsDb, card, (msg) => log.debug(msg));

      out.push({
        kind: 'fsrs_card',
        cardStateId: state.id,
        ankiCardId: card.ankiCardId,
        deckName: card.deckName,
        cardFormat,
        front: card.front,
        back: card.back,
        fields,
        templateId: card.templateId,
        state: state.state,
        lapses: state.lapses,
        reps: state.reps,
        stability: state.stability,
        difficulty: state.difficulty,
        isDue,
        isBuried,
        daysSinceLastReview,
        daysOverdue,
        historicalMeanSeconds: hist?.meanSeconds ?? null,
        historicalReviewCount: hist?.reviewCount ?? 0,
        conceptMasteryScore,
        inActiveSpaceScope: deckFilter !== null || inFolderScope,
        hasExamPriorityTag: card.tags.some((t) => EXAM_TAG_RE.test(t)),
        conceptTags,
        sourceAnchor,
      });
    }

    return out;
  }

  private loadQuestionByIdMap(
    vfsDb: SqlExecutor,
    repos: VfsReposService,
    questionIds: readonly string[],
  ): Map<string, Question> {
    const map = new Map<string, Question>();
    if (questionIds.length === 0) return map;
    const unique = [...new Set(questionIds)];

    if (typeof repos.questions?.getQuestionsByIds === 'function') {
      try {
        const loaded = repos.questions.getQuestionsByIds(vfsDb, unique);
        for (const q of loaded) {
          map.set(q.id, q);
        }
        return map;
      } catch (error) {
        this.logger().debug(
          `[exam-sprint] getQuestionsByIds fallback to getQuestion: ${errorText(error)}`,
        );
      }
    }

    if (typeof repos.questions?.getQuestion === 'function') {
      for (const id of unique) {
        try {
          const q = repos.questions.getQuestion(vfsDb, id);
          if (q !== null) {
            map.set(id, q);
          }
        } catch (error) {
          this.logger().debug(`[exam-sprint] Question lookup skipped for ${id}: ${errorText(error)}`);
        }
      }
    }
    return map;
  }

  private harvestMistakeCandidates(params: {
    config: ExamHorizonConfig;
    nowMs: number;
    logicalTodayKey: string;
    folderScope: examSprintRepo.FolderScopeResourceIds | null;
    masteryCache: Map<string, number | null>;
  }): {
    candidates: MistakeTriageCandidate[];
    plansById: Map<string, ReviewPlan>;
    questionsById: Map<string, Question>;
  } {
    const vfsDb = this.tryVfsDb();
    const repos = this.tryVfsRepos();
    const plansById = new Map<string, ReviewPlan>();
    const questionsById = new Map<string, Question>();
    if (vfsDb === null || repos === null || typeof repos.reviewPlans?.listDueReviews !== 'function') {
      return { candidates: [], plansById, questionsById };
    }

    const log = this.logger();
    let activePlans: ReviewPlan[] = [];
    try {
      let offset = 0;
      for (;;) {
        const page = repos.reviewPlans.listDueReviews(vfsDb, {
          until_date: '9999-12-31', limit: 1500, offset,
        });
        activePlans.push(...page.plans);
        if (!page.has_more || page.plans.length === 0) break;
        offset += page.plans.length;
      }
    } catch (error) {
      log.warn(`[exam-sprint] listDueReviews failed: ${errorText(error)}`);
      return { candidates: [], plansById, questionsById };
    }

    const scopedPlans =
      params.folderScope !== null
        ? activePlans.filter((plan) => params.folderScope!.itemIds.has(plan.exam_id))
        : activePlans;

    if (scopedPlans.length === 0) {
      return { candidates: [], plansById, questionsById };
    }

    const loadedQuestions = this.loadQuestionByIdMap(
      vfsDb,
      repos,
      scopedPlans.map((p) => p.question_id),
    );
    for (const [qid, q] of loadedQuestions.entries()) {
      questionsById.set(qid, q);
    }

    const examNameCache = new Map<string, string | null>();
    const resolveExamName = (examId: string): string | null => {
      if (examNameCache.has(examId)) return examNameCache.get(examId) ?? null;
      let name: string | null = null;
      if (typeof repos.exams?.getExamSheet === 'function') {
        try {
          name = nullableTrimmed(repos.exams.getExamSheet(vfsDb, examId)?.examName);
        } catch (error) {
          log.debug(`[exam-sprint] getExamSheet skipped for ${examId}: ${errorText(error)}`);
        }
      }
      examNameCache.set(examId, name);
      return name;
    };

    const durations = examSprintRepo.readReviewPlanHistoricalDurations(
      vfsDb,
      (msg) => log.debug(msg),
    );
    const todayDayNum =
      parseYmdUtcDayNumber(params.logicalTodayKey) ??
      parseYmdUtcDayNumber(localDateKey()) ??
      Math.floor(params.nowMs / MS_PER_DAY);

    const candidates: MistakeTriageCandidate[] = [];
    for (const plan of scopedPlans) {
      if (plan.status === 'suspended') continue;
      const question = questionsById.get(plan.question_id);
      if (question === undefined) continue;
      plansById.set(plan.id, plan);

      const nextDayNum = parseYmdUtcDayNumber(plan.next_review_date);
      const isDue = nextDayNum === null ? true : nextDayNum <= todayDayNum;
      const daysOverdue =
        nextDayNum !== null && isDue ? Math.max(0, todayDayNum - nextDayNum) : 0;
      const lastDayNum = parseYmdUtcDayNumber(plan.last_review_date);
      const daysSinceLastReview =
        lastDayNum !== null ? Math.max(0, todayDayNum - lastDayNum) : null;

      const rawTags = Array.isArray(question.tags)
        ? question.tags
            .map(normalizeConceptTag)
            .filter((tag): tag is string => tag !== null)
        : [];
      const examName = resolveExamName(plan.exam_id);
      const fallbackTag =
        rawTags.length === 0 && examName !== null ? normalizeConceptTag(examName) : null;
      const conceptTags =
        rawTags.length > 0 ? rawTags : fallbackTag !== null ? [fallbackTag] : [];

      const hist = durations.get(plan.id);
      const conceptMasteryScore = this.lookupConceptMasteryScore(conceptTags, params.masteryCache);
      const failureCount = Math.max(
        plan.consecutive_failures,
        Math.max(0, plan.total_reviews - plan.total_correct),
      );
      const options =
        Array.isArray(question.options) && question.options.length > 0
          ? question.options.map((opt) => ({
              key: String(opt.key),
              content: String(opt.content),
            }))
          : null;
      const sourceAnchor = resolveQuestionSourceAnchor(
        vfsDb,
        question,
        examName,
        (msg) => log.debug(msg),
      );

      candidates.push({
        kind: 'mistake_question',
        planId: plan.id,
        examId: plan.exam_id,
        examName,
        questionId: question.id,
        originalQuestionId: question.id,
        isVariant: false,
        variantBadgeReason: null,
        questionType: question.question_type ?? 'other',
        content: question.content ?? '',
        options,
        answer: question.answer ?? null,
        explanation: question.explanation ?? null,
        structuredData: sanitizeWireJsonValue(question.structured_data),
        originalPromptPreview: null,
        originalAnswerPreview: null,
        status: plan.status,
        lapsesCount: failureCount,
        consecutiveFailures: plan.consecutive_failures,
        isDifficult: plan.is_difficult,
        repetitions: plan.repetitions,
        intervalDays: plan.interval_days,
        easeFactor: plan.ease_factor,
        isDue,
        daysSinceLastReview,
        daysOverdue,
        historicalMeanSeconds: hist?.meanSeconds ?? null,
        historicalReviewCount: hist?.reviewCount ?? 0,
        conceptMasteryScore,
        inActiveSpaceScope:
          params.folderScope !== null && params.folderScope.itemIds.has(plan.exam_id),
        hasExamPriorityTag:
          Array.isArray(question.tags) && question.tags.some((t) => EXAM_TAG_RE.test(t)),
        conceptTags,
        sourceAnchor,
      });
    }

    return { candidates, plansById, questionsById };
  }

  private resolveMindmapNodeAnchor(
    vfsDb: SqlExecutor,
    mindmapId: string,
    mindmapTitle: string,
    node: RawMindmapNodeShape,
  ): SprintSourceAnchor {
    const log = this.logger();
    const edge = examSprintRepo.readOutboundAnchorForSource(
      vfsDb,
      'mindmap',
      mindmapId,
      node.id,
      (msg) => log.debug(msg),
    );
    if (edge !== null) {
      const fromEdge = anchorFromOutboundEdge(edge);
      if (fromEdge !== null) return fromEdge;
    }

    if (node.href !== null && node.href.startsWith('ds-anchor://v1/')) {
      const fromHref = parseDsAnchorUri(node.href, mindmapTitle);
      if (fromHref !== null) return fromHref;
    }

    if (node.refs.length > 0) {
      const firstRef = node.refs[0]!;
      const mappedKind = normalizeAnchorKind(firstRef.type);
      if (mappedKind !== null) {
        return {
          anchorUri: `ds-anchor://v1/${mappedKind}/${encodeURIComponent(firstRef.sourceId)}`,
          kind: mappedKind,
          resourceId: firstRef.sourceId,
          label: firstRef.name ?? mindmapTitle,
          page: null,
          startMs: null,
          blockId: null,
          nodeId: mappedKind === 'mindmap' ? node.id : null,
          questionId: null,
          quote: null,
        };
      }
    }

    return {
      anchorUri: `ds-anchor://v1/mindmap/${encodeURIComponent(mindmapId)}?node=${encodeURIComponent(node.id)}`,
      kind: 'mindmap',
      resourceId: mindmapId,
      label: mindmapTitle,
      page: null,
      startMs: null,
      blockId: null,
      nodeId: node.id,
      questionId: null,
      quote: null,
    };
  }

  private harvestMindmapCandidates(params: {
    nowMs: number;
    folderScope: examSprintRepo.FolderScopeResourceIds | null;
    clientSignals: readonly ClientMindmapReciteSignal[] | null | undefined;
    masteryCache: Map<string, number | null>;
  }): MindmapTriageCandidate[] {
    const vfsDb = this.tryVfsDb();
    const repos = this.tryVfsRepos();
    if (vfsDb === null || repos === null || typeof repos.mindmaps?.listMindmaps !== 'function') {
      return [];
    }

    const log = this.logger();
    let mindmaps: ReturnType<VfsReposService['mindmaps']['listMindmaps']> = [];
    try {
      mindmaps = repos.mindmaps.listMindmaps(vfsDb);
    } catch (error) {
      log.debug(`[exam-sprint] listMindmaps skipped: ${errorText(error)}`);
      return [];
    }

    const scopedMindmaps =
      params.folderScope !== null
        ? mindmaps.filter(
            (mm) =>
              params.folderScope!.itemIds.has(mm.id) ||
              params.folderScope!.itemIds.has(mm.resourceId),
          )
        : mindmaps;

    const signalMap = new Map<string, ClientMindmapReciteSignal>();
    if (Array.isArray(params.clientSignals)) {
      for (const sig of params.clientSignals) {
        if (typeof sig !== 'object' || sig === null) continue;
        const mmId = nullableTrimmed(sig.mindmapId);
        const nId = nullableTrimmed(sig.nodeId);
        if (mmId === null || nId === null) continue;
        const attemptsVal = typeof sig.attempts === 'number' && Number.isFinite(sig.attempts)
          ? Math.max(0, Math.trunc(sig.attempts))
          : 0;
        const missesVal = typeof sig.misses === 'number' && Number.isFinite(sig.misses)
          ? Math.max(0, Math.trunc(sig.misses))
          : 0;
        const lastMsVal =
          typeof sig.lastReviewedAtMs === 'number' && Number.isFinite(sig.lastReviewedAtMs)
            ? sig.lastReviewedAtMs
            : null;
        signalMap.set(`${mmId}:${nId}`, {
          mindmapId: mmId,
          nodeId: nId,
          attempts: attemptsVal,
          misses: missesVal,
          lastReviewedAtMs: lastMsVal,
        });
      }
    }

    const out: MindmapTriageCandidate[] = [];
    let visitedNodes = 0;

    const selectedMindmaps = scopedMindmaps.slice(0, MAX_MINDMAPS_TO_HARVEST);
    for (const mm of selectedMindmaps) {
      if (visitedNodes >= MAX_MINDMAP_NODES_TO_HARVEST) break;
      let rawJson: string | null = null;
      try {
        rawJson = repos.mindmaps.getMindmapContent(vfsDb, mm.id);
      } catch (error) {
        log.debug(`[exam-sprint] getMindmapContent skipped for ${mm.id}: ${errorText(error)}`);
        continue;
      }
      const rootNode = parseMindmapRootNode(rawJson, MAX_MINDMAP_NODES_TO_HARVEST - visitedNodes);
      if (rootNode === null) continue;

      const mindmapTitle = nullableTrimmed(mm.title) ?? '思维导图';
      const inScope =
        params.folderScope !== null &&
        (params.folderScope.itemIds.has(mm.id) || params.folderScope.itemIds.has(mm.resourceId));

      const walk = (
        node: RawMindmapNodeShape,
        ancestors: readonly string[],
        siblings: readonly RawMindmapNodeShape[],
      ): void => {
        if (visitedNodes >= MAX_MINDMAP_NODES_TO_HARVEST) return;
        visitedNodes += 1;

        const fullText = node.text;
        const signal = signalMap.get(`${mm.id}:${node.id}`);
        const hasExplicitBlanks = node.blankedRanges.length > 0;
        const hasSignalHistory =
          signal !== undefined && (signal.misses > 0 || signal.attempts > 0);
        const isHighPriorityTarget =
          (node.priority === 1 || node.priority === 2) && fullText.length >= 6;

        if (fullText.length > 0 && (hasExplicitBlanks || hasSignalHistory || isHighPriorityTarget)) {
          const effectiveRanges = hasExplicitBlanks
            ? node.blankedRanges
            : computeAutoMaskRange(fullText);
          const maskedText = buildMaskedText(fullText, effectiveRanges);
          const siblingHints = siblings
            .filter((sib) => sib.id !== node.id && sib.text.length > 0)
            .slice(0, MAX_SIBLING_HINTS)
            .map((sib) =>
              sib.text === fullText
                ? FULLWIDTH_CLOZE_MASK
                : truncateText(sib.text, MAX_SIBLING_HINT_CHARS),
            );

          const attempts = signal?.attempts ?? 0;
          const misses = Math.min(attempts, signal?.misses ?? 0);
          const daysSinceLastReview =
            signal?.lastReviewedAtMs !== null && signal?.lastReviewedAtMs !== undefined
              ? Math.max(0, (params.nowMs - signal.lastReviewedAtMs) / MS_PER_DAY)
              : 0;

          const parentConcept = ancestors.length > 0 ? ancestors[ancestors.length - 1]! : mindmapTitle;
          const normalizedConcept = normalizeConceptTag(parentConcept);
          const conceptTags = normalizedConcept !== null ? [normalizedConcept] : [];
          const conceptMasteryScore = this.lookupConceptMasteryScore(
            conceptTags,
            params.masteryCache,
          );

          const smoothedError = (misses + 1) / (attempts + 2);
          const isWeakCandidate =
            smoothedError >= 0.45 ||
            (attempts === 0 && (hasExplicitBlanks || isHighPriorityTarget));

          out.push({
            kind: 'mindmap_cloze',
            mindmapId: mm.id,
            mindmapTitle,
            nodeId: node.id,
            ancestorPath: [...ancestors],
            siblingHints,
            fullText,
            maskedText,
            blankedRanges: effectiveRanges,
            noteExcerpt: node.note !== null ? truncateText(node.note, 200) : null,
            attempts,
            misses,
            daysSinceLastReview,
            priority: node.priority,
            isWeakCandidate,
            historicalMeanSeconds: null,
            historicalReviewCount: 0,
            conceptMasteryScore,
            inActiveSpaceScope: inScope,
            hasExamPriorityTag: isHighPriorityTarget,
            conceptTags,
            sourceAnchor: this.resolveMindmapNodeAnchor(vfsDb, mm.id, mindmapTitle, node),
          });
        }

        const nextAncestors = fullText.length > 0 ? [...ancestors, fullText] : ancestors;
        for (const child of node.children) {
          if (visitedNodes >= MAX_MINDMAP_NODES_TO_HARVEST) break;
          walk(child, nextAncestors, node.children);
        }
      };

      walk(rootNode, [], []);
    }

    return out;
  }

  private evaluateTriageState(params: {
    config: ExamHorizonConfig;
    clientMindmapSignals?: readonly ClientMindmapReciteSignal[] | null;
  }): {
    snapshot: ExamReadinessSnapshot;
    selectedItems: SprintQueueItem[];
    deferredBacklogCount: number;
    plansById: Map<string, ReviewPlan>;
    questionsById: Map<string, Question>;
    fsrsParams: number[];
  } {
    const nowMs = utcNow().ms;
    const mistakesDb = this.mistakesDb();
    const vfsDb = this.tryVfsDb();
    const log = this.logger();

    const [dayStartMs, nextDayStartMs] = logicalDayBoundsMs(nowMs, params.config.dayRolloverHour);
    let deckNewPerDay = 20;
    let newIntroducedToday = 0;
    let fsrsParams: number[] = [];
    try {
      const summary = examSprintRepo.loadDefaultDeckSchedulerSummary(
        mistakesDb,
        dayStartMs,
        nextDayStartMs,
        (msg) => log.warn(msg),
      );
      deckNewPerDay = summary.newPerDay;
      newIntroducedToday = summary.newIntroducedToday;
      fsrsParams = summary.fsrsParams;
    } catch (error) {
      log.debug(`[exam-sprint] Deck scheduler summary fallback: ${errorText(error)}`);
    }

    const folderScope = examSprintRepo.readFolderResourceIds(
      vfsDb,
      params.config.rootFolderId,
      (msg) => log.debug(msg),
    );
    const masteryCache = new Map<string, number | null>();
    const logicalTodayKey = logicalLocalDateKey(nowMs, params.config.dayRolloverHour);

    const fsrsCandidates = this.harvestFsrsCandidates({
      config: params.config,
      nowMs,
      nextDayStartMs,
      folderScope,
      masteryCache,
    });
    const mistakeHarvest = this.harvestMistakeCandidates({
      config: params.config,
      nowMs,
      logicalTodayKey,
      folderScope,
      masteryCache,
    });
    const mindmapCandidates = this.harvestMindmapCandidates({
      nowMs,
      folderScope,
      clientSignals: params.clientMindmapSignals,
      masteryCache,
    });

    const candidates: TriageCandidateInput[] = [
      ...fsrsCandidates,
      ...mistakeHarvest.candidates,
      ...mindmapCandidates,
    ];

    const triage = runExamHorizonTriage({
      config: params.config,
      nowMs,
      candidates,
      fsrsParams,
      deckNewPerDay,
      newIntroducedToday,
    });

    return {
      snapshot: triage.snapshot,
      selectedItems: triage.selectedItems,
      deferredBacklogCount: triage.deferredBacklogCount,
      plansById: mistakeHarvest.plansById,
      questionsById: mistakeHarvest.questionsById,
      fsrsParams,
    };
  }

  getExamReadiness(
    spaceIdOrRequest: string | null | GetExamReadinessRequest = null,
    _call?: RemoteCallMeta,
  ): ExamReadinessSnapshot {
    let requestObj: GetExamReadinessRequest;
    if (spaceIdOrRequest === null) {
      requestObj = { spaceId: null };
    } else if (typeof spaceIdOrRequest === 'string') {
      requestObj = { spaceId: spaceIdOrRequest };
    } else {
      requestObj = spaceIdOrRequest;
    }

    const config = this.resolveEffectiveConfig(requestObj);
    return this.evaluateTriageState({
      config,
      clientMindmapSignals: requestObj.clientMindmapSignals ?? null,
    }).snapshot;
  }

  async buildDailySprintPlan(
    request: BuildDailySprintRequest,
    call?: RemoteCallMeta,
  ): Promise<DailySprintPlan> {
    const safeReq: BuildDailySprintRequest = isPlainRecord(request)
      ? request
      : { spaceId: null };
    const config = this.resolveEffectiveConfig(safeReq);
    const evaluated = this.evaluateTriageState({
      config,
      clientMindmapSignals: safeReq.clientMindmapSignals ?? null,
    });

    const enableAiVariants = safeReq.enableAiVariants !== false;
    const maxLiveVariants = Number.isFinite(safeReq.maxLiveVariants)
      ? Math.max(0, Math.min(10, Math.trunc(safeReq.maxLiveVariants ?? 2)))
      : 2;

    let liveGenerated = 0;
    let generatedVariantsCount = 0;
    let items: SprintQueueItem[] = [...evaluated.selectedItems];

    if (enableAiVariants) {
      for (let i = 0; i < items.length; i += 1) {
        const currentItem = items[i]!;
        if (currentItem.kind !== 'mistake_question') continue;

        const plan = evaluated.plansById.get(currentItem.planId) ?? null;
        const originalQuestion = evaluated.questionsById.get(currentItem.originalQuestionId);
        if (originalQuestion === undefined) continue;

        const eligibility = resolveVariantEligibility(plan, originalQuestion);
        if (!eligibility.eligible) continue;

        const cachedVariant = this.variantGenerator.getCachedVariant(originalQuestion);
        if (cachedVariant !== null) {
          const updatedItem: SprintMistakeItem = {
            ...currentItem,
            questionId: cachedVariant.id,
            originalQuestionId: originalQuestion.id,
            isVariant: true,
            variantBadgeReason: eligibility.badgeReason,
            questionType: cachedVariant.question_type,
            content: cachedVariant.content,
            options:
              Array.isArray(cachedVariant.options) && cachedVariant.options.length > 0
                ? cachedVariant.options.map((opt) => ({
                    key: String(opt.key),
                    content: String(opt.content),
                  }))
                : null,
            answer: cachedVariant.answer ?? null,
            explanation: cachedVariant.explanation ?? null,
            structuredData: sanitizeWireJsonValue(cachedVariant.structured_data),
            originalPromptPreview: truncateText(originalQuestion.content, 180),
            originalAnswerPreview: originalQuestion.answer ?? null,
          };
          items[i] = updatedItem;
          generatedVariantsCount += 1;
          continue;
        }

        if (liveGenerated >= maxLiveVariants || call?.signal?.aborted) {
          continue;
        }

        const resolved = await this.variantGenerator.resolveOrGenerateVariant({
          originalQuestion,
          plan,
          forceRegenerate: false,
          allowLiveGeneration: true,
          signal: call?.signal,
        });
        // The limit bounds attempts, not just successful generations (timeouts cost time too).
        liveGenerated += 1;

        if (resolved.isVariant) {
          generatedVariantsCount += 1;
          const updatedItem: SprintMistakeItem = {
            ...currentItem,
            questionId: resolved.variantQuestionId,
            originalQuestionId: originalQuestion.id,
            isVariant: true,
            variantBadgeReason: eligibility.badgeReason,
            questionType: resolved.questionType,
            content: resolved.content,
            options: resolved.options,
            answer: resolved.answer,
            explanation: resolved.explanation,
            structuredData: sanitizeWireJsonValue(resolved.structuredData),
            originalPromptPreview: truncateText(originalQuestion.content, 180),
            originalAnswerPreview: originalQuestion.answer ?? null,
          };
          items[i] = updatedItem;
        }
      }

      if (generatedVariantsCount > 0) {
        items = interleaveSprintQueue(items);
      }
    }

    // A choice mistake takes longer after becoming a variant. Repack before publishing
    // the plan so the displayed duration and deferred count describe the actual queue.
    let estimatedSeconds = 0;
    const budgetSeconds = config.sprintBudgetMinutes * 60;
    items = items.map((item) => {
      if (item.kind === 'mistake_question' && item.isVariant) {
        const seconds = Math.max(50, item.triage.estimatedSeconds);
        item.triage = { ...item.triage, estimatedSeconds: seconds,
          utilityScore: item.triage.utilityScore * item.triage.estimatedSeconds / seconds };
      }
      return item;
    }).sort((a, b) => b.triage.utilityScore - a.triage.utilityScore || a.sprintItemId.localeCompare(b.sprintItemId))
      .filter((item) => {
        if (estimatedSeconds + item.triage.estimatedSeconds > budgetSeconds) return false;
        estimatedSeconds += item.triage.estimatedSeconds;
        return true;
      });
    items = interleaveSprintQueue(items);
    const selectedDueCount = items.filter((item) => item.kind !== 'fsrs_card' || item.state !== 0).length;
    const before = evaluated.snapshot;
    const deferredBacklogCount = Math.max(0,
      before.breakdown.fsrsDueCount + before.breakdown.mistakeDueCount + before.breakdown.mindmapWeakCount - selectedDueCount);
    const readinessBefore = {
      ...before,
      selectedSprintCount: items.length,
      estimatedSprintSeconds: estimatedSeconds,
      estimatedSprintMinutes: items.length === 0 ? 0 : Math.max(1, Math.round(estimatedSeconds / 60)),
      deferredBacklogCount,
    };
    generatedVariantsCount = items.filter((item) => item.kind === 'mistake_question' && item.isVariant).length;

    return {
      planSessionId: `sprint_${globalThis.crypto.randomUUID()}`,
      config,
      readinessBefore,
      items,
      deferredBacklogCount,
      generatedVariantsCount,
      createdAtMs: utcNow().ms,
    };
  }

  async generateMistakeVariant(
    request: GenerateMistakeVariantRequest,
    call?: RemoteCallMeta,
  ): Promise<GenerateMistakeVariantResult> {
    if (!isPlainRecord(request) || typeof request.questionId !== 'string' || request.questionId.trim().length === 0) {
      throw appError('Validation', 'questionId must be a non-empty string');
    }
    const questionId = request.questionId.trim();
    const qbank = (this.ctx.get('qbank') as QbankService | undefined) ?? null;
    const vfsDb = this.tryVfsDb();
    const repos = this.tryVfsRepos();

    let originalQuestion: MistakeQuestionRecord | null = null;
    if (qbank !== null) {
      try {
        originalQuestion = qbank.getQuestion(questionId);
      } catch (error) {
        this.logger().debug(`[exam-sprint] qbank.getQuestion fallback: ${errorText(error)}`);
      }
    }
    if (originalQuestion === null && vfsDb !== null && repos !== null) {
      originalQuestion = repos.questions.getQuestion(vfsDb, questionId);
    }
    if (originalQuestion === null) {
      throw appError('NotFound', `Question not found: ${questionId}`);
    }

    let plan: ReviewPlan | null = null;
    if (vfsDb !== null && repos !== null && typeof repos.reviewPlans?.getPlan === 'function') {
      const requestedPlanId = nullableTrimmed(request.planId);
      try {
        plan =
          requestedPlanId !== null
            ? repos.reviewPlans.getPlan(vfsDb, requestedPlanId)
            : repos.reviewPlans.getPlanByQuestion(vfsDb, originalQuestion.id);
      } catch (error) {
        this.logger().debug(`[exam-sprint] Plan lookup skipped for ${questionId}: ${errorText(error)}`);
      }
    }

    const hasImages =
      (Array.isArray(originalQuestion.images) && originalQuestion.images.length > 0) ||
      (Array.isArray(originalQuestion.materials) &&
        originalQuestion.materials.some(
          (mat) => Array.isArray(mat.images) && mat.images.length > 0,
        ));
    if (hasImages) {
      return {
        variantQuestionId: originalQuestion.id,
        originalQuestionId: originalQuestion.id,
        isVariant: false,
        fromCache: false,
        content: originalQuestion.content,
        options:
          Array.isArray(originalQuestion.options) && originalQuestion.options.length > 0
            ? originalQuestion.options.map((opt) => ({
                key: String(opt.key),
                content: String(opt.content),
              }))
            : null,
        answer: originalQuestion.answer ?? null,
        explanation: originalQuestion.explanation ?? null,
        structuredData: sanitizeWireJsonValue(originalQuestion.structured_data),
        questionType: originalQuestion.question_type,
        fallbackReason: 'image_question_unsupported',
      };
    }

    const resolved = await this.variantGenerator.resolveOrGenerateVariant({
      originalQuestion,
      plan,
      forceRegenerate: request.forceRegenerate === true,
      allowLiveGeneration: true,
      signal: call?.signal,
    });

    return {
      ...resolved,
      structuredData: sanitizeWireJsonValue(resolved.structuredData),
    };
  }

  settleSprintSession(
    request: SettleSprintSessionRequest,
    _call?: RemoteCallMeta,
  ): SprintSessionSettlement {
    const log = this.logger();
    const replay = examSprintRepo.readSprintSettlement(this.mistakesDb(), request.planSessionId);
    if (replay !== null) return replay;
    const config = this.resolveEffectiveConfig({
      spaceId: request.spaceId ?? null,
      rootFolderId: request.rootFolderId ?? null,
      examDateOverride: request.examDateOverride ?? null,
      sprintBudgetMinutesOverride: request.sprintBudgetMinutesOverride ?? null,
      defaultDeckIdOverride: request.defaultDeckIdOverride ?? null,
    });

    const now = utcNow();
    const daysUntilExam = computeDaysUntilExam(
      now.ms,
      config.examDate,
      config.dayRolloverHour,
    );
    const effectiveTargetRetention = computeEffectiveTargetRetention(
      daysUntilExam,
      config.baseTargetRetention,
    );

    const fsrsSvc = this.fsrsService();
    const reviewPlanSvc = this.reviewPlanService();
    const mastery = this.tryMastery();
    const vfsDb = this.tryVfsDb();
    const repos = this.tryVfsRepos();

    let passedCount = 0;
    let againCount = 0;
    let masteryEventsWritten = 0;
    const byKind = {
      fsrsCards: 0,
      mistakes: 0,
      variantsSolved: 0,
      mindmapNodes: 0,
    };

    const conceptTracker = new Map<
      string,
      { scoreBefore: number | null; hadPass: boolean; hadFail: boolean }
    >();
    const trackConceptBefore = (rawTag: string, passed: boolean): string | null => {
      const concept = normalizeConceptTag(rawTag);
      if (concept === null) return null;
      let existing = conceptTracker.get(concept);
      if (existing === undefined) {
        let before: number | null = null;
        if (mastery !== null) {
          try {
            before = mastery.getState(concept)?.score ?? null;
          } catch (error) {
            log.debug(`[exam-sprint] mastery.getState before failed for ${concept}: ${errorText(error)}`);
          }
        }
        existing = { scoreBefore: before, hadPass: false, hadFail: false };
        conceptTracker.set(concept, existing);
      }
      if (passed) existing.hadPass = true;
      else existing.hadFail = true;
      return concept;
    };

    const changedFsrsCards: Array<readonly [string, string]> = [];
    const changedFsrsLogIds: Array<string | null> = [];

    const rawCompletedItems = Array.isArray(request.completedItems) ? request.completedItems : [];
    const hadAgainByItem = new Map<string, boolean>();
    const dedupedMap = new Map<string, (typeof rawCompletedItems)[number]>();
    for (const rawItem of rawCompletedItems) {
      if (rawItem.rating === 1) {
        againCount += 1;
        hadAgainByItem.set(rawItem.sprintItemId, true);
      }
      dedupedMap.set(rawItem.sprintItemId, rawItem);
    }
    const completedItems = [...dedupedMap.values()];
    for (const item of completedItems) {
      const operationId = `sprint:${request.planSessionId}:${item.sprintItemId}`;
      const rating: 1 | 2 | 3 | 4 =
        item.rating === 1 || item.rating === 2 || item.rating === 3 || item.rating === 4
          ? item.rating
          : 3;
      const passed = Boolean(item.passed);
      if (passed) passedCount += 1;

      const rawConceptTags = Array.isArray(item.conceptTags) ? item.conceptTags : [];
      for (const tag of rawConceptTags) {
        trackConceptBefore(tag, passed);
      }

      if (item.kind === 'fsrs_card') {
        byKind.fsrsCards += 1;
        if (!item.alreadyCommittedInline && item.cardStateId !== null) {
          try {
            const stateBefore = fsrsSvc.getCardState(item.cardStateId);
            const ankiCardId = item.ankiCardId ?? stateBefore?.ankiCardId ?? null;
            const dbTags = ankiCardId !== null ? fsrsSvc.getCardConceptTags(ankiCardId) : [];
            const mergedTags = [...new Set([...rawConceptTags, ...dbTags])]
              .map(normalizeConceptTag)
              .filter((t): t is string => t !== null);
            for (const tag of mergedTags) {
              trackConceptBefore(tag, rating >= 3);
            }
            const preConcept = mergedTags[0] ?? null;
            const preScore =
              preConcept !== null && mastery !== null
                ? (mastery.getState(preConcept)?.score ?? null)
                : null;

            const durationMs = Number.isFinite(item.elapsedMs)
              ? Math.max(100, Math.round(item.elapsedMs))
              : null;
            const compressInterval = (
              scheduledDays: number,
              stabilityAfter: number,
              fsrsParams: readonly number[],
            ) =>
              compressIntervalForExamHorizon({
                scheduledDays,
                stabilityAfter,
                daysUntilExam,
                effectiveTargetRetention,
                fsrsParams,
              });
            if (hadAgainByItem.get(item.sprintItemId) === true && rating >= 2) {
              const lapseRated = fsrsSvc.rateWithMasteryBias(
                item.cardStateId,
                1,
                durationMs,
                preScore,
                null,
                {
                  operationId: `${operationId}:lapse`,
                  desiredRetention: effectiveTargetRetention,
                  compressInterval,
                },
              );
              changedFsrsLogIds.push(lapseRated.logId);
            }
            const rated = fsrsSvc.rateWithMasteryBias(
              item.cardStateId,
              rating,
              durationMs,
              preScore,
              null,
              {
                operationId,
                desiredRetention: effectiveTargetRetention,
                compressInterval,
              },
            );

            changedFsrsCards.push([item.cardStateId, rated.cardState.ankiCardId]);
            changedFsrsLogIds.push(rated.logId);

            if (mastery !== null) {
              const tagsForMastery =
                mergedTags.length > 0
                  ? mergedTags
                  : [`card:${rated.cardState.ankiCardId}`];
              trackConceptBefore(tagsForMastery[0]!, rating >= 3);
              const mState = mastery.recordFsrsRatingForLog(
                rated.logId,
                rated.cardState.ankiCardId,
                tagsForMastery,
                rating,
              );
              fsrsSvc.markMasteryReviewSynced(rated.logId);
              if (mState !== null) {
                masteryEventsWritten += 1;
              }
            }
          } catch (error) {
            log.warn(
              `[exam-sprint] Failed to settle FSRS item ${item.sprintItemId}: ${errorText(error)}`,
            );
            throw error;
          }
        }
      } else if (item.kind === 'mistake_question') {
        byKind.mistakes += 1;
        if (item.isVariant) {
          byKind.variantsSolved += 1;
        }
        if (!item.alreadyCommittedInline) {
          const resolvedPlanId =
            nullableTrimmed(item.planId) ??
            (item.originalQuestionId !== null && reviewPlanSvc !== null
              ? (reviewPlanSvc.getPlanByQuestion(item.originalQuestionId)?.id ?? null)
              : null);
          let planMasteryWritten = false;
          let rootQuestionId = item.originalQuestionId ?? item.questionId;

          if (resolvedPlanId !== null && reviewPlanSvc !== null) {
            try {
              const quality = sm2QualityFromSprintRating(rating, passed);
              const spentSecs = Number.isFinite(item.elapsedMs)
                ? Math.max(1, Math.round(item.elapsedMs / 1000))
                : null;
              if (vfsDb !== null && repos !== null) {
                const existingPlan = repos.reviewPlans.getPlan(vfsDb, resolvedPlanId);
                if (existingPlan !== null) {
                  rootQuestionId = existingPlan.question_id;
                  const rootQ = repos.questions.getQuestion(vfsDb, existingPlan.question_id);
                  if (rootQ !== null) {
                    for (const tag of rootQ.tags) {
                      trackConceptBefore(tag, passed);
                    }
                    if (mastery !== null) {
                      planMasteryWritten = true;
                    }
                  }
                }
              }
              reviewPlanSvc.processReview(resolvedPlanId, quality, null, spentSecs, operationId);
              if (planMasteryWritten) {
                masteryEventsWritten += 1;
              }
            } catch (error) {
              log.warn(
                `[exam-sprint] Failed to advance ReviewPlan ${resolvedPlanId}: ${errorText(error)}`,
              );
              throw error;
            }
          }

          const qbank = this.ctx.get('qbank') as QbankService | undefined;
          if (item.questionId !== null && typeof qbank?.submitAnswer === 'function') {
            // The Sprint is self-rated; do not fabricate an option letter as a user answer.
            // Advance the root plan first so qbank's practice hook cannot advance it twice.
            const submitted = qbank.submitAnswer(item.questionId, '', passed, operationId);
            // On an original (not variant), the plan receipt already records this exact
            // recall. Keep that durable receipt and discard the duplicate evidence only.
            if (planMasteryWritten && item.questionId === rootQuestionId && submitted.submission_id !== null && vfsDb !== null) {
              const state = vfsDb.transaction((tx) => {
                const id = `me_qbank_${submitted.submission_id}`;
                const concept = eventConcept(tx, id);
                if (concept === null) return null;
                tombstone(tx, id, utcNow().rfc);
                return recomputeStateWithConn(tx, concept);
              }, { behavior: 'immediate' });
              if (state !== null) mastery?.syncLearnerProfile(state);
            }
            planMasteryWritten = true;
          }

          if (mastery !== null) {
            const targetQid = nullableTrimmed(item.questionId) ?? nullableTrimmed(rootQuestionId);
            const shouldWriteVariantOrFallbackMastery =
              targetQid !== null &&
              typeof qbank?.submitAnswer !== 'function' &&
              (!planMasteryWritten || (item.isVariant && targetQid !== rootQuestionId));
            if (shouldWriteVariantOrFallbackMastery && targetQid !== null) {
              try {
                const tags = rawConceptTags
                  .map(normalizeConceptTag)
                  .filter((t): t is string => t !== null);
                if (tags[0] !== undefined) {
                  trackConceptBefore(tags[0], passed);
                } else {
                  trackConceptBefore(`item:${targetQid}`, passed);
                }
                mastery.recordEvent('qbank', tags[0] ?? `item:${targetQid}`, targetQid,
                  passed ? 'correct' : 'wrong', `${operationId}:question`);
                masteryEventsWritten += 1;
              } catch (error) {
                log.warn(
                  `[exam-sprint] Failed to record qbank mastery for ${targetQid}: ${errorText(error)}`,
                );
                throw error;
              }
            }
          }
        }
      } else if (item.kind === 'mindmap_cloze') {
        byKind.mindmapNodes += 1;
        if (!item.alreadyCommittedInline && mastery !== null) {
          const normalizedTags = [
            ...new Set(
              rawConceptTags
                .map(normalizeConceptTag)
                .filter((t): t is string => t !== null),
            ),
          ];
          const fallbackConcept =
            normalizedTags.length > 0
              ? null
              : normalizeConceptTag(item.mindmapId ?? item.nodeId ?? 'mindmap_node');
          const conceptsToRecord =
            normalizedTags.length > 0
              ? normalizedTags
              : fallbackConcept !== null
                ? [fallbackConcept]
                : [];

          for (const conceptKey of conceptsToRecord) {
            trackConceptBefore(conceptKey, rating >= 3);
            try {
              const state = mastery.recordEvent('insight', conceptKey, item.sprintItemId, {
                rating,
              }, `${operationId}:concept:${conceptKey}`);
              try {
                mastery.syncLearnerProfile(state);
              } catch (syncError) {
                log.debug(
                  `[exam-sprint] Learner profile sync skipped for ${conceptKey}: ${errorText(syncError)}`,
                );
              }
              masteryEventsWritten += 1;
            } catch (error) {
              log.warn(
                `[exam-sprint] Failed to record insight mastery for ${conceptKey}: ${errorText(error)}`,
              );
              throw error;
            }
          }
        }
      }
    }

    const totalElapsedSeconds = Number.isFinite(request.totalElapsedSeconds)
      ? Math.max(0, Math.round(request.totalElapsedSeconds))
      : 0;
    let studyTimeRecordedSeconds = 0;
    if (completedItems.length > 0 && totalElapsedSeconds >= 5) {
      let remaining = totalElapsedSeconds;
      while (remaining > 0) {
        const chunk = Math.min(3600, remaining);
        try {
          studyTimeAdd(this.ctx, chunk, null);
          studyTimeRecordedSeconds += chunk;
        } catch (error) {
          log.warn(`[exam-sprint] studyTimeAdd failed: ${errorText(error)}`);
          break;
        }
        remaining -= chunk;
      }
    }

    if (changedFsrsCards.length > 0) {
      const payload = buildFsrsChangedPayloadAfterWrite(
        true,
        'user',
        'rate',
        changedFsrsCards,
        [],
        changedFsrsLogIds,
      );
      if (payload !== null) {
        try {
          this.ctx.backendEvents.emit('fsrs://changed', payload);
        } catch (error) {
          log.debug(`[exam-sprint] fsrs://changed emit skipped: ${errorText(error)}`);
        }
      }
    }

    const mergedMindmapSignals = new Map<string, ClientMindmapReciteSignal>();
    if (Array.isArray(request.clientMindmapSignalsAfter)) {
      for (const sig of request.clientMindmapSignalsAfter) {
        if (typeof sig !== 'object' || sig === null) continue;
        const mmId = nullableTrimmed(sig.mindmapId);
        const nId = nullableTrimmed(sig.nodeId);
        if (mmId !== null && nId !== null) {
          mergedMindmapSignals.set(`${mmId}:${nId}`, sig);
        }
      }
    }
    const settledAtMs = utcNow().ms;
    for (const item of completedItems) {
      if (item.kind !== 'mindmap_cloze') continue;
      const mmId = nullableTrimmed(item.mindmapId);
      const nId = nullableTrimmed(item.nodeId);
      if (mmId === null || nId === null) continue;
      const key = `${mmId}:${nId}`;
      if (!mergedMindmapSignals.has(key)) {
        mergedMindmapSignals.set(key, {
          mindmapId: mmId,
          nodeId: nId,
          attempts: 1,
          misses: item.rating <= 2 ? 1 : 0,
          lastReviewedAtMs: settledAtMs,
        });
      }
    }

    const readinessAfter = this.getExamReadiness({
      spaceId: request.spaceId ?? null,
      rootFolderId: request.rootFolderId ?? null,
      examDateOverride: request.examDateOverride ?? null,
      sprintBudgetMinutesOverride: request.sprintBudgetMinutesOverride ?? null,
      defaultDeckIdOverride: request.defaultDeckIdOverride ?? null,
      clientMindmapSignals: [...mergedMindmapSignals.values()],
    });

    const beforePred = request.readinessBefore?.predictedExamRetrievability ?? null;
    const afterPred = readinessAfter.predictedExamRetrievability;
    const readinessDeltaPctPoints =
      beforePred !== null &&
      afterPred !== null &&
      Number.isFinite(beforePred) &&
      Number.isFinite(afterPred)
        ? round1((afterPred - beforePred) * 100)
        : null;

    const conceptDeltas: ConceptMasteryDelta[] = [];
    if (mastery !== null) {
      for (const [concept, info] of conceptTracker.entries()) {
        if (conceptDeltas.length >= 5) break;
        let scoreAfter: number | null = null;
        try {
          scoreAfter = mastery.getState(concept)?.score ?? null;
        } catch (error) {
          log.debug(`[exam-sprint] mastery.getState after failed for ${concept}: ${errorText(error)}`);
        }
        if (scoreAfter === null || !Number.isFinite(scoreAfter)) continue;
        const outcome: ConceptMasteryDelta['outcome'] =
          scoreAfter < 0.50 || (info.hadFail && !info.hadPass)
            ? 'needs_reinforce'
            : info.scoreBefore === null
              ? info.hadPass
                ? 'improved'
                : 'steady'
              : scoreAfter > info.scoreBefore + 0.005 || (info.hadPass && !info.hadFail)
                ? 'improved'
                : 'steady';
        conceptDeltas.push({
          concept,
          scoreAfter: round4(scoreAfter),
          outcome,
        });
      }
    }

    const settlement: SprintSessionSettlement = {
      planSessionId: request.planSessionId,
      readinessBefore: request.readinessBefore,
      readinessAfter,
      readinessDeltaPctPoints,
      totalCompleted: completedItems.length,
      passedCount,
      againCount,
      totalElapsedSeconds,
      studyTimeRecordedSeconds,
      masteryEventsWritten,
      byKind,
      conceptDeltas,
    };
    this.mistakesDb().transaction((tx) => examSprintRepo.writeSprintSettlement(tx, settlement, utcNow().rfc), { behavior: 'immediate' });
    return settlement;
  }
}
