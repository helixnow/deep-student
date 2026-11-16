/**
 * `studyData` 门面（B1）：把官方学习数据服务收成一层小而稳定的纯 JSON 接口，给社区插件 / 工坊作品用。
 *
 * - 官方服务调用时才用 `ctx.get` 解析（插件不硬依赖它们）；没有运行时抛 `STUDY_DATA_UNAVAILABLE`。
 * - 写操作复用界面走的同一条服务调用，并发出界面依赖的同一组变更事件（`dstu:change`、`fsrs://changed`、
 *   `todo://changed`、`qbank://changed`），打开着的页面会刷新；另外发出对应的应用事件（`study/*`）。
 * - 只经各插件 `api.ts` 的类型与 vfs 的 portable 入口取用，不跨插件引用实现。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { NotesService, VfsNote } from '../../notes/api.ts';
import type { AnkiService } from '../../anki/api.ts';
import type { QbankService, Question } from '../../qbank/api.ts';
import type { ReviewService } from '../../review/api.ts';
import type { TodoItem, VfsReposService } from '../../vfs-repos/api.ts';
import type { DstuNode, VfsDatabase } from '../../vfs/portable.ts';
import {
  createdEvent, getContentCommand, listCommand, noteToDstuNode, searchCommand, updatedEvent,
} from '../../vfs/portable.ts';
import { errorDisplay } from '../../../platform/errors/api.ts';
import { emitStudyEvent } from '../api.ts';
import type {
  StudyCard, StudyCardCreateInput, StudyCardListOptions, StudyCardState, StudyCardStatusFilter, StudyDataService,
  StudyDueCard, StudyNote, StudyNoteCreateInput, StudyNoteListOptions, StudyNoteSearchHit, StudyNoteUpdateInput,
  StudyNoteWithContent, StudyQuestion, StudyQuestionCreateInput, StudyQuestionDifficulty, StudyQuestionListOptions,
  StudyQuestionSet, StudyQuestionSetListOptions, StudyQuestionType, StudyResource, StudyResourceListOptions,
  StudyResourceType, StudyReviewEnqueueResult, StudyReviewStats, StudyTodo, StudyTodoAddInput, StudyTodoList,
  StudyTodoListOptions, StudyTodoPriority,
} from './study-data-types.ts';

// ------------------------------------------------------------------ helpers

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** qbank 仓储把每页限制在 100（`question_repo.rs`）。 */
const MAX_QUESTION_LIMIT = 100;
const MAX_TITLE_LENGTH = 500;
const MAX_TEXT_LENGTH = 10 * 1024 * 1024;
const MAX_TAGS = 100;
const MAX_ENQUEUE = 500;

function invalid(message: string): never {
  throw new Error(`STUDY_DATA_INVALID: ${message}`);
}

function notFound(message: string): never {
  throw new Error(`STUDY_DATA_NOT_FOUND: ${message}`);
}

/** 官方服务抛出的非 Error 值（裸 AppError 等）转成带可读文本的 Error。 */
function rethrow(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new Error(errorDisplay(error));
}

async function run<T>(work: () => T): Promise<T> {
  try {
    return work();
  } catch (error) {
    return rethrow(error);
  }
}

function optionsObject<T extends object>(value: T | undefined, name: string): Partial<T> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object`);
  return value;
}

function requireId(value: unknown, name = 'id'): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalId(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : requireId(value, name);
}

function requireText(value: unknown, name: string, { allowEmpty = false, max = MAX_TEXT_LENGTH } = {}): string {
  if (typeof value !== 'string') invalid(`${name} must be a string`);
  if (!allowEmpty && value.trim() === '') invalid(`${name} must not be empty`);
  if (value.length > max) invalid(`${name} is longer than ${max} characters`);
  return value;
}

function optionalText(value: unknown, name: string, options?: { allowEmpty?: boolean; max?: number }): string | undefined {
  return value === undefined || value === null ? undefined : requireText(value, name, { allowEmpty: true, ...options });
}

function tagsOf(value: unknown, name = 'tags'): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) invalid(`${name} must be an array of strings`);
  const tags = [...new Set(value.map((tag) => tag.trim()).filter((tag) => tag !== ''))];
  if (tags.length > MAX_TAGS) invalid(`${name} has more than ${MAX_TAGS} entries`);
  return tags;
}

function limitOf(value: unknown, max = MAX_LIMIT): number {
  if (value === undefined || value === null) return Math.min(DEFAULT_LIMIT, max);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) invalid('limit must be a positive integer');
  return Math.min(value, max);
}

function offsetOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) invalid('offset must be a non-negative integer');
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    invalid(`${name} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function isoFromMs(value: number | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function isoTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'string') invalid(`${name} must be an ISO 8601 string`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) invalid(`${name} must be an ISO 8601 string`);
  return ms;
}

/**
 * offset/limit 换成页码接口：页大小取 `limit`，取覆盖 `[offset, offset+limit)` 的一或两页再切片。
 */
function pagedSlice<T>(offset: number, limit: number, fetch: (page: number, pageSize: number) => T[]): T[] {
  const first = Math.floor(offset / limit) + 1;
  const skip = offset % limit;
  const items = fetch(first, limit);
  if (skip > 0 && items.length === limit) items.push(...fetch(first + 1, limit));
  return items.slice(skip, skip + limit);
}

function fsrsState(value: number | null | undefined): StudyCardState | null {
  switch (value) {
    case 0: return 'new';
    case 1: return 'learning';
    case 2: return 'review';
    case 3: return 'relearning';
    default: return null;
  }
}

// ------------------------------------------------------------------ service resolution

interface Services {
  notes(): NotesService;
  anki(): AnkiService;
  qbank(): QbankService;
  review(): ReviewService;
  vfsRepo(): VfsReposService;
  vfsDatabase(): VfsDatabase;
}

function resolver(ctx: Context): Services {
  const get = <T>(name: string, label: string): T => {
    const service = ctx.get(name as never) as T | undefined;
    if (service === undefined || service === null) throw new Error(`STUDY_DATA_UNAVAILABLE: ${label} service is not running`);
    return service;
  };
  return {
    notes: () => get<NotesService>('notes', 'notes'),
    anki: () => get<AnkiService>('anki', 'anki'),
    qbank: () => get<QbankService>('qbank', 'qbank'),
    review: () => get<ReviewService>('review', 'review'),
    vfsRepo: () => get<VfsReposService>('vfsRepo', 'vfsRepo'),
    vfsDatabase: () => get<VfsDatabase>('vfsDatabase', 'vfsDatabase'),
  };
}

/** 界面依赖的后端事件；发不出去只记日志，不影响已提交的写入（与官方命令一致）。 */
function backendEmitter(ctx: Context): (event: string, payload: unknown) => void {
  const logger = ctx.logger('study-data');
  return (event, payload) => {
    try {
      ctx.backendEvents.emit(event, payload);
    } catch (error) {
      logger.debug(`failed to emit ${event}: ${errorDisplay(error)}`);
    }
  };
}

// ------------------------------------------------------------------ mapping

function noteDto(note: VfsNote): StudyNote {
  return {
    id: note.id,
    title: note.title,
    tags: [...note.tags],
    favorite: note.isFavorite,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function noteWithContentDto(note: VfsNote, content: string): StudyNoteWithContent {
  return { ...noteDto(note), content };
}

/** 命中词附近约 160 字的纯文本摘录。 */
export function noteExcerpt(content: string, query: string): string {
  const text = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = text.toLowerCase();
  let at = -1;
  for (const token of query.toLowerCase().split(/\s+/).filter((part) => part !== '')) {
    at = lower.indexOf(token);
    if (at >= 0) break;
  }
  const start = Math.max(0, at < 0 ? 0 : at - 60);
  const end = Math.min(text.length, start + 160);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

type LibraryCard = ReturnType<AnkiService['listAnkiAgentLibraryCards']>['items'][number];

function cardDto(card: LibraryCard): StudyCard {
  return {
    id: card.id,
    front: card.front,
    back: card.back,
    tags: [...card.tags],
    templateId: card.template_id ?? null,
    fields: { ...card.extra_fields },
    createdAt: card.created_at,
    updatedAt: card.updated_at,
    review: {
      enqueued: card.enqueued,
      suspended: card.suspended,
      due: card.isDue,
      dueAt: isoFromMs(card.dueMs),
      state: fsrsState(card.state),
      stateId: card.stateId,
    },
  };
}

function questionDto(question: Question): StudyQuestion {
  return {
    id: question.id,
    setId: question.exam_id,
    label: question.question_label,
    type: question.question_type,
    content: question.content,
    options: (question.options ?? []).map((option) => ({ key: option.key, content: option.content })),
    answer: question.answer,
    explanation: question.explanation,
    difficulty: question.difficulty,
    tags: [...question.tags],
    status: question.status,
    attemptCount: question.attempt_count,
    correctCount: question.correct_count,
    lastAttemptAt: question.last_attempt_at,
    lastCorrect: question.is_correct,
    userNote: question.user_note,
    favorite: question.is_favorite,
    createdAt: question.created_at,
    updatedAt: question.updated_at,
  };
}

function todoTags(item: TodoItem): string[] {
  try {
    const parsed: unknown = JSON.parse(item.tagsJson);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function todoDto(item: TodoItem): StudyTodo {
  return {
    id: item.id,
    listId: item.todoListId,
    title: item.title,
    note: item.description ?? null,
    done: item.status === 'completed',
    priority: item.priority as StudyTodoPriority,
    dueDate: item.dueDate ?? null,
    dueTime: item.dueTime ?? null,
    tags: todoTags(item),
    completedAt: item.completedAt ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

const RESOURCE_TYPES: readonly StudyResourceType[] = [
  'folder', 'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'mindmap',
];

function resourceDto(node: DstuNode): StudyResource | null {
  if (!(RESOURCE_TYPES as readonly string[]).includes(node.type)) return null;
  const metadata = (node.metadata !== null && typeof node.metadata === 'object' ? node.metadata : {}) as Record<string, unknown>;
  const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const favorite = metadata.isFavorite ?? metadata.is_favorite ?? metadata.favorite;
  return {
    id: node.id,
    type: node.type as StudyResourceType,
    title: node.name,
    path: node.path,
    size: typeof node.size === 'number' ? node.size : null,
    tags,
    favorite: favorite === true,
    createdAt: isoFromMs(node.createdAt) ?? new Date(0).toISOString(),
    updatedAt: isoFromMs(node.updatedAt) ?? new Date(0).toISOString(),
  };
}

const QUESTION_TYPES: readonly StudyQuestionType[] = [
  'single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'short_answer', 'essay',
  'calculation', 'proof', 'true_false', 'matching', 'ordering', 'numeric', 'other',
];
const DIFFICULTIES: readonly StudyQuestionDifficulty[] = ['easy', 'medium', 'hard', 'very_hard'];
const TODO_PRIORITIES: readonly StudyTodoPriority[] = ['none', 'low', 'medium', 'high', 'urgent'];
const CARD_STATUS: readonly StudyCardStatusFilter[] = ['all', 'due', 'new', 'learning', 'review', 'suspended', 'notEnqueued'];

// ------------------------------------------------------------------ facade

export function createStudyDataService(ctx: Context): StudyDataService {
  const services = resolver(ctx);
  const emit = backendEmitter(ctx);
  const vfsConn = () => services.vfsDatabase().getConn();

  /** `dstu_create` / `dstu_update` 的 `emit_watch_event`：路径事件 + 通用 `dstu:change`。 */
  const emitNoteWatch = (note: VfsNote, created: boolean): void => {
    const node = noteToDstuNode(note);
    const event = created ? createdEvent(node.path, node) : updatedEvent(node.path, node);
    emit(`dstu:change:${event.path}`, event);
    emit('dstu:change', event);
    emitStudyEvent(ctx, 'study/note-saved', { noteId: note.id, title: note.title, created, updatedAt: note.updatedAt });
  };

  const loadNote = (id: string): [VfsNote, string] | null => {
    const found = services.notes().repository.getNoteWithContent(id);
    if (found === null || (found[0].deletedAt ?? null) !== null) return null;
    return found;
  };

  const loadCard = (id: string): StudyCard | null => {
    const record = services.anki().getAnkiAgentLibraryCard(id);
    return record === null ? null : cardDto(record.libraryCard);
  };

  /** `fsrs_enqueue_cards` 的入队 + `emit_fsrs_enqueue_changed`。 */
  const enqueueCards = (cardIds: string[]): StudyReviewEnqueueResult => {
    const review = services.review();
    const result = review.enqueueCards(cardIds);
    if (result.enqueuedStateIds.length > 0) {
      try {
        const loaded = review.getEnqueuedCards(result);
        const byState = new Map(loaded.map((card) => [card.id, card]));
        const cards = result.enqueuedStateIds.map((stateId) => byState.get(stateId));
        if (cards.every((card) => card !== undefined)) {
          emit('fsrs://changed', {
            source: 'user',
            action: 'enqueue',
            entityIds: cards.map((card) => card.ankiCardId),
            cardStateIds: cards.map((card) => card.id),
            cards,
          });
        }
      } catch (error) {
        ctx.logger('study-data').debug(`failed to load enqueued cards for fsrs://changed: ${errorDisplay(error)}`);
      }
    }
    return { enqueued: result.enqueued, skipped: result.skipped };
  };

  const todoListsWithInbox = () => {
    const repo = services.vfsRepo().todos;
    const conn = vfsConn();
    return { repo, conn, lists: repo.listTodoLists(conn) };
  };

  return {
    notes: {
      list: (options) => run(() => {
        const opts = optionsObject<StudyNoteListOptions>(options, 'options');
        const search = optionalText(opts.search, 'search', { max: 1000 });
        const folderId = optionalId(opts.folderId, 'folderId');
        if (search !== undefined && folderId !== undefined) invalid('search and folderId cannot be combined');
        const since = opts.updatedSince === undefined ? undefined : isoTimestamp(opts.updatedSince, 'updatedSince');
        const limit = limitOf(opts.limit);
        const offset = offsetOf(opts.offset);
        const repo = services.notes().repository;
        const notes = folderId !== undefined
          ? repo.listNotesByFolder(folderId, limit, offset)
          : repo.listNotes(search !== undefined && search.trim() !== '' ? search : null, limit, offset);
        const filtered = since === undefined ? notes : notes.filter((note) => Date.parse(note.updatedAt) > since);
        return filtered.map(noteDto);
      }),

      get: (id) => run(() => {
        const found = loadNote(requireId(id));
        return found === null ? null : noteWithContentDto(found[0], found[1]);
      }),

      search: (query, limit) => run(() => {
        const text = requireText(query, 'query', { max: 1000 });
        const repo = services.notes().repository;
        return repo.listNotes(text, limitOf(limit), 0).map((note): StudyNoteSearchHit => ({
          ...noteDto(note),
          excerpt: noteExcerpt(repo.getNoteContent(note.id) ?? '', text),
        }));
      }),

      create: (input) => run(() => {
        const value = optionsObject<StudyNoteCreateInput>(input, 'input');
        const title = requireText(value.title, 'title', { max: MAX_TITLE_LENGTH }).trim();
        const content = optionalText(value.content, 'content') ?? '';
        const tags = tagsOf(value.tags) ?? [];
        const folderId = optionalId(value.folderId, 'folderId');
        const repo = services.notes().repository;
        const note = folderId === undefined
          ? repo.createNote({ title, content, tags })
          : repo.createNoteInFolder({ title, content, tags }, folderId);
        emitNoteWatch(note, true);
        return noteWithContentDto(note, content);
      }),

      update: (id, patch) => run(() => {
        const noteId = requireId(id);
        const value = optionsObject<StudyNoteUpdateInput>(patch, 'patch');
        const title = value.title === undefined ? undefined : requireText(value.title, 'title', { max: MAX_TITLE_LENGTH }).trim();
        const content = optionalText(value.content, 'content');
        const tags = tagsOf(value.tags);
        const expectedUpdatedAt = value.expectedUpdatedAt === undefined
          ? undefined : requireText(value.expectedUpdatedAt, 'expectedUpdatedAt', { max: 64 });
        if (title === undefined && content === undefined && tags === undefined) invalid('patch must change title, content or tags');
        if (loadNote(noteId) === null) notFound(`note ${noteId} does not exist`);
        const repo = services.notes().repository;
        const note = repo.updateNote(noteId, {
          title: title ?? null,
          content: content ?? null,
          tags: tags ?? null,
          expectedUpdatedAt: expectedUpdatedAt ?? null,
        });
        emitNoteWatch(note, false);
        return noteWithContentDto(note, content ?? repo.getNoteContent(note.id) ?? '');
      }),

      append: (id, markdown) => run(() => {
        const noteId = requireId(id);
        const addition = requireText(markdown, 'markdown');
        const found = loadNote(noteId);
        if (found === null) notFound(`note ${noteId} does not exist`);
        const [current, content] = found;
        const separator = content.trim() === '' ? '' : content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
        const next = `${content.trim() === '' ? '' : content}${separator}${addition}`;
        if (next.length > MAX_TEXT_LENGTH) invalid(`note content would be longer than ${MAX_TEXT_LENGTH} characters`);
        const note = services.notes().repository.updateNote(noteId, {
          content: next,
          expectedUpdatedAt: current.updatedAt,
        });
        emitNoteWatch(note, false);
        return noteWithContentDto(note, next);
      }),
    },

    cards: {
      list: (options) => run(() => {
        const opts = optionsObject<StudyCardListOptions>(options, 'options');
        const search = optionalText(opts.search, 'search', { max: 1000 });
        const status = oneOf(opts.status, CARD_STATUS, 'status');
        const templateId = optionalId(opts.templateId, 'templateId');
        const limit = limitOf(opts.limit);
        const offset = offsetOf(opts.offset);
        const anki = services.anki();
        return pagedSlice(offset, limit, (page, pageSize) => anki.listAnkiAgentLibraryCards({
          search: search === undefined || search.trim() === '' ? null : search,
          templateId: templateId ?? null,
          filter: { status: status === undefined || status === 'all' ? null : status },
          page,
          pageSize,
        }).items).map(cardDto);
      }),

      get: (id) => run(() => loadCard(requireId(id))),

      create: (input) => run(() => {
        const value = optionsObject<StudyCardCreateInput>(input, 'input');
        const front = requireText(value.front, 'front').trim();
        const back = requireText(value.back, 'back').trim();
        const tags = tagsOf(value.tags) ?? [];
        const templateId = optionalId(value.templateId, 'templateId');
        let fields: Record<string, string> | undefined;
        if (value.fields !== undefined && value.fields !== null) {
          if (typeof value.fields !== 'object' || Array.isArray(value.fields)
            || !Object.values(value.fields).every((field) => typeof field === 'string')) {
            invalid('fields must be an object of strings');
          }
          fields = { ...value.fields };
        }
        if (value.enqueue !== undefined && typeof value.enqueue !== 'boolean') invalid('enqueue must be a boolean');
        const anki = services.anki();
        if (templateId !== undefined && anki.templates.get(templateId) === null) notFound(`card template ${templateId} does not exist`);
        if (typeof anki.saveCards !== 'function') throw new Error('STUDY_DATA_UNAVAILABLE: anki service cannot save cards');
        const response = anki.saveCards({
          cards: [{ front, back, tags, images: [], ...(fields === undefined ? {} : { fields }), template_id: templateId ?? null }],
        });
        const cardId = response.savedIds[0] ?? response.cardIdMappings[0]?.persistedId;
        if (cardId === undefined) {
          throw new Error(`STUDY_DATA_FAILED: card was not saved${response.failed[0] ? `: ${response.failed[0].error}` : ''}`);
        }
        // save_anki_cards: build_save_anki_cards_changed_payload.
        emit('fsrs://changed', { source: 'user', action: 'cards_persisted', entityIds: [cardId] });
        emitStudyEvent(ctx, 'study/cards-created', { cardIds: [cardId], documentId: null });
        if (value.enqueue !== false) enqueueCards([cardId]);
        const card = loadCard(cardId);
        if (card === null) throw new Error(`STUDY_DATA_FAILED: card ${cardId} was saved but cannot be read back`);
        return card;
      }),
    },

    questions: {
      sets: (options) => run(() => {
        const opts = optionsObject<StudyQuestionSetListOptions>(options, 'options');
        const search = optionalText(opts.search, 'search', { max: 1000 });
        const repos = services.vfsRepo();
        return repos.exams.listExamSheets(vfsConn(), search === undefined || search.trim() === '' ? null : search,
          limitOf(opts.limit), offsetOf(opts.offset)).map((sheet): StudyQuestionSet => ({
          id: sheet.id,
          title: sheet.examName ?? sheet.id,
          favorite: sheet.isFavorite,
          createdAt: sheet.createdAt,
          updatedAt: sheet.updatedAt,
        }));
      }),

      list: (options) => run(() => {
        const opts = optionsObject<StudyQuestionListOptions>(options, 'options');
        const setId = optionalId(opts.setId, 'setId');
        const rawSearch = optionalText(opts.search, 'search', { max: 1000 });
        const search = rawSearch === undefined || rawSearch.trim() === '' ? undefined : rawSearch;
        const limit = limitOf(opts.limit, MAX_QUESTION_LIMIT);
        const offset = offsetOf(opts.offset);
        if (setId !== undefined) {
          const qbank = services.qbank();
          return pagedSlice(offset, limit, (page, pageSize) =>
            qbank.listQuestions(setId, search === undefined ? {} : { search }, page, pageSize).questions).map(questionDto);
        }
        const repos = services.vfsRepo();
        const conn = vfsConn();
        if (search !== undefined) {
          return pagedSlice(offset, limit, (page, pageSize) =>
            repos.questions.searchQuestions(conn, search, null, {}, page, pageSize).results.map((hit) => hit.question))
            .map(questionDto);
        }
        // 跨题目集：按题目集列表顺序逐个列出，取够 offset + limit 为止。
        const qbank = services.qbank();
        const wanted = offset + limit;
        const collected: Question[] = [];
        for (const sheet of repos.exams.listAllExamSheets(conn)) {
          for (let page = 1; collected.length < wanted; page += 1) {
            const result = qbank.listQuestions(sheet.id, {}, page, MAX_QUESTION_LIMIT);
            collected.push(...result.questions);
            if (!result.has_more) break;
          }
          if (collected.length >= wanted) break;
        }
        return collected.slice(offset, wanted).map(questionDto);
      }),

      search: (query, limit) => run(() => {
        const text = requireText(query, 'query', { max: 1000 });
        return services.vfsRepo().questions.searchQuestions(vfsConn(), text, null, {}, 1, limitOf(limit, MAX_QUESTION_LIMIT))
          .results.map((hit) => questionDto(hit.question));
      }),

      get: (id) => run(() => {
        const question = services.qbank().getQuestion(requireId(id));
        return question === null ? null : questionDto(question);
      }),

      create: (input) => run(() => {
        const value = optionsObject<StudyQuestionCreateInput>(input, 'input');
        const setId = requireId(value.setId, 'setId');
        const content = requireText(value.content, 'content');
        const type = oneOf(value.type, QUESTION_TYPES, 'type');
        const difficulty = oneOf(value.difficulty, DIFFICULTIES, 'difficulty');
        let options: { key: string; content: string }[] | undefined;
        if (value.options !== undefined && value.options !== null) {
          if (!Array.isArray(value.options) || !value.options.every((option) => option !== null && typeof option === 'object'
            && typeof option.key === 'string' && option.key.trim() !== '' && typeof option.content === 'string')) {
            invalid('options must be an array of { key, content } strings');
          }
          options = value.options.map((option) => ({ key: option.key.trim(), content: option.content }));
        }
        const answer = optionalText(value.answer, 'answer');
        const explanation = optionalText(value.explanation, 'explanation');
        const tags = tagsOf(value.tags);
        const label = optionalText(value.label, 'label', { max: 100 });
        if (services.vfsRepo().exams.getExamSheet(vfsConn(), setId) === null) notFound(`question set ${setId} does not exist`);
        const question = services.qbank().createQuestion({
          exam_id: setId,
          content,
          options: options ?? null,
          answer: answer ?? null,
          explanation: explanation ?? null,
          question_type: type ?? null,
          difficulty: difficulty ?? null,
          tags: tags ?? null,
          question_label: label ?? null,
          source_type: 'manual',
        });
        emit('qbank://changed', { source: 'user', action: 'create_question', entityIds: [question.id], examId: setId });
        return questionDto(question);
      }),
    },

    review: {
      stats: () => run((): StudyReviewStats => {
        const stats = services.review().getStats();
        return {
          total: stats.total,
          due: stats.due,
          newCount: stats.newCount,
          learning: stats.learning,
          review: stats.review,
          relearning: stats.relearning,
          suspended: stats.suspended,
          reviewsToday: stats.reviewsToday,
          newRemainingToday: stats.newRemainingToday,
          reviewsRemainingToday: stats.reviewsRemainingToday,
        };
      }),

      due: (options) => run(() => {
        const opts = optionsObject<{ limit?: number }>(options, 'options');
        return services.review().getDue(limitOf(opts.limit)).map((card): StudyDueCard => ({
          stateId: card.id,
          cardId: card.ankiCardId,
          front: card.front,
          back: card.back,
          state: fsrsState(card.state) ?? 'new',
          dueAt: isoFromMs(card.dueMs) ?? new Date(0).toISOString(),
          lastReviewAt: isoFromMs(card.lastReviewMs),
          reps: card.reps,
          lapses: card.lapses,
        }));
      }),

      enqueue: (cardIds) => run(() => {
        if (!Array.isArray(cardIds) || cardIds.length === 0) invalid('cardIds must be a non-empty array');
        if (cardIds.length > MAX_ENQUEUE) invalid(`cardIds has more than ${MAX_ENQUEUE} entries`);
        return enqueueCards([...new Set(cardIds.map((id) => requireId(id, 'cardIds[]')))]);
      }),
    },

    todos: {
      lists: () => run(() => {
        const { lists } = todoListsWithInbox();
        return lists.map((list): StudyTodoList => ({ id: list.id, title: list.title, isDefault: list.isDefault }));
      }),

      list: (options) => run(() => {
        const opts = optionsObject<StudyTodoListOptions>(options, 'options');
        if (opts.includeDone !== undefined && typeof opts.includeDone !== 'boolean') invalid('includeDone must be a boolean');
        const includeDone = opts.includeDone === true;
        const listId = optionalId(opts.listId, 'listId');
        const limit = limitOf(opts.limit);
        const { repo, conn, lists } = todoListsWithInbox();
        if (listId !== undefined) {
          if (!lists.some((list) => list.id === listId)) notFound(`todo list ${listId} does not exist`);
          return repo.listItemsByList(conn, listId, includeDone, limit, 0).map(todoDto);
        }
        if (!includeDone) return repo.listAllPendingItems(conn).slice(0, limit).map(todoDto);
        const items: TodoItem[] = [];
        for (const list of lists) {
          if (items.length >= limit) break;
          items.push(...repo.listItemsByList(conn, list.id, true, limit - items.length, 0));
        }
        return items.map(todoDto);
      }),

      search: (query, limit) => run(() => {
        const text = requireText(query, 'query', { max: 1000 });
        const repo = services.vfsRepo().todos;
        return repo.searchItemsPaginated(vfsConn(), text, limitOf(limit), 0)[0].map(todoDto);
      }),

      add: (input) => run(() => {
        const value = optionsObject<StudyTodoAddInput>(input, 'input');
        const title = requireText(value.title, 'title', { max: MAX_TITLE_LENGTH }).trim();
        const note = optionalText(value.note, 'note');
        const dueDate = optionalText(value.dueDate, 'dueDate', { max: 10 });
        const dueTime = optionalText(value.dueTime, 'dueTime', { max: 5 });
        if (dueDate !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)))) {
          invalid('dueDate must be YYYY-MM-DD');
        }
        if (dueTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) invalid('dueTime must be HH:MM');
        if (dueTime !== undefined && dueDate === undefined) invalid('dueTime needs dueDate');
        const priority = oneOf(value.priority, TODO_PRIORITIES, 'priority') ?? 'none';
        const tags = tagsOf(value.tags);
        const requestedList = optionalId(value.listId, 'listId');
        const { repo, conn, lists } = todoListsWithInbox();
        let listId: string;
        if (requestedList !== undefined) {
          if (!lists.some((list) => list.id === requestedList)) notFound(`todo list ${requestedList} does not exist`);
          listId = requestedList;
        } else {
          listId = repo.ensureDefaultInbox(conn).id;
        }
        const item = repo.createTodoItem(conn, {
          todoListId: listId,
          title,
          description: note ?? null,
          priority,
          dueDate: dueDate ?? null,
          dueTime: dueTime ?? null,
          tags: tags ?? null,
        });
        emit('todo://changed', { source: 'user', action: 'create', entityIds: [item.id] });
        return todoDto(item);
      }),

      complete: (id) => run(() => {
        const itemId = requireId(id);
        const repo = services.vfsRepo().todos;
        const conn = vfsConn();
        const current = repo.getTodoItem(conn, itemId);
        if (current === null || (current.deletedAt ?? null) !== null) notFound(`todo ${itemId} does not exist`);
        if (current.status === 'completed') return todoDto(current);
        // todo_toggle_item: pending → completed (the repository spawns the next recurrence).
        const item = repo.toggleTodoItem(conn, itemId, current.updatedAt);
        emit('todo://changed', { source: 'user', action: 'toggle', entityIds: [item.id] });
        return todoDto(item);
      }),
    },

    resources: {
      list: (options) => run(() => {
        const opts = optionsObject<StudyResourceListOptions>(options, 'options');
        const folderId = optionalId(opts.folderId, 'folderId');
        const type = oneOf(opts.type, RESOURCE_TYPES, 'type');
        const limit = limitOf(opts.limit);
        const offset = offsetOf(opts.offset);
        const nodes = listCommand({ database: services.vfsDatabase(), log: ctx.logger('study-data') }, {
          ...(folderId === undefined ? {} : { folderId }),
          ...(type === undefined ? {} : { typeFilter: type }),
          limit,
          offset,
        } as Parameters<typeof listCommand>[1]);
        return nodes.map(resourceDto).filter((item): item is StudyResource => item !== null).slice(0, limit);
      }),

      search: (query, limit) => run(() => {
        const text = requireText(query, 'query', { max: 1000 });
        const max = limitOf(limit);
        const nodes = searchCommand({ database: services.vfsDatabase(), log: ctx.logger('study-data') }, text,
          { limit: max } as Parameters<typeof searchCommand>[2]);
        return nodes.map(resourceDto).filter((item): item is StudyResource => item !== null).slice(0, max);
      }),

      readText: (id) => run(() => {
        const resourceId = requireId(id);
        if (resourceId.startsWith('fld_')) invalid('folders have no text; list them with resources.list({ folderId })');
        const text = getContentCommand({ database: services.vfsDatabase() }, resourceId);
        const ocr = /^<image_ocr id="[^"]*">([\s\S]*)<\/image_ocr>$/.exec(text);
        return ocr === null ? text : ocr[1]!;
      }),
    },
  };
}
