import { create } from 'zustand';
import i18n from '@/i18n';
import type {
  AnkiLibraryCard,
  AnkiLibraryCardPatch,
  AnkiLibraryDeckCount,
  AnkiLibraryListResponse,
  AnkiLibraryStatusCounts,
} from '@/types';
import {
  deleteAnkiCard,
  enqueueAnkiLibraryCard,
  listAnkiLibraryCards,
  resetFsrsCardProgress,
  suspendFsrsCard,
  undoFsrsLastReview,
  unsuspendFsrsCard,
  updateAnkiLibraryCard,
} from '@/utils/chatApi';
import { getErrorMessage } from '@/utils/errorUtils';
import { requestFlashcardsDueRefresh } from '../events';
import { hasValidCloze } from '../cloze';
import type { ReviewEditTemplate } from '../reviewCardEditFields';

export const FLASHCARDS_LIBRARY_PAGE_SIZE = 20;
export const FLASHCARDS_LIBRARY_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
export type LibraryPageSize = (typeof FLASHCARDS_LIBRARY_PAGE_SIZE_OPTIONS)[number];

/** 状态筛选（服务端执行，跨页生效；计数见 statusCounts）。 */
export type LibraryStatusFilter =
  | 'all'
  | 'due'
  | 'new'
  | 'learning'
  | 'review'
  | 'suspended'
  | 'notEnqueued';

/** 排序（服务端执行，跨页生效；'default' = 创建时间倒序）。 */
export type LibrarySortKey = 'default' | 'due' | 'created' | 'front';
export type LibrarySortDir = 'asc' | 'desc';

const DEFAULT_SORT_DIR: Record<Exclude<LibrarySortKey, 'default'>, LibrarySortDir> = {
  due: 'asc',
  created: 'desc',
  front: 'asc',
};

interface FlashcardsLibraryState {
  items: AnkiLibraryCard[];
  total: number;
  page: number;
  pageSize: number;
  searchInput: string;
  query: string;
  loading: boolean;
  loadError: string | null;
  actionError: string | null;
  busyCardId: string | null;
  /** 手动新建 / APKG 导入进行中（工具栏与空态 CTA 共用） */
  creating: boolean;
  importing: boolean;
  /** 批量操作进行中（与单卡 busyCardId 互斥使用）。 */
  bulkBusy: boolean;
  loaded: boolean;
  statusFilter: LibraryStatusFilter;
  sortKey: LibrarySortKey;
  sortDir: LibrarySortDir;
  /** 各状态全集计数（旧后端无此字段时为 null，界面退回本页计数） */
  statusCounts: AnkiLibraryStatusCounts | null;
  /** 牌组筛选（含子牌组）；null = 全部，'' = 未分组 */
  deckFilter: string | null;
  /** 全库按牌组计数（旧后端无此字段时为 null，界面不显示牌组筛选） */
  decks: AnkiLibraryDeckCount[] | null;

  setSearchInput: (value: string) => void;
  setStatusFilter: (filter: LibraryStatusFilter) => void;
  setDeckFilter: (deck: string | null) => void;
  /** 再次点击当前排序键时翻转方向。 */
  toggleSort: (key: Exclude<LibrarySortKey, 'default'>) => void;
  clearSort: () => void;
  /** 清空搜索 / 状态筛选 / 排序，只重拉一次 */
  clearFilters: () => Promise<boolean>;
  clearActionError: () => void;
  load: (query?: string, page?: number) => Promise<boolean>;
  refresh: () => Promise<boolean>;
  submitSearch: (query?: string) => Promise<boolean>;
  goToPage: (page: number) => Promise<boolean>;
  setPageSize: (pageSize: number) => Promise<boolean>;
  enqueueCard: (cardId: string) => Promise<boolean>;
  setCardSuspended: (cardId: string, suspended: boolean) => Promise<boolean>;
  updateCard: (
    cardId: string,
    patch: AnkiLibraryCardPatch,
    template?: ReviewEditTemplate | null,
  ) => Promise<boolean>;
  undoLastReview: (cardId: string) => Promise<boolean>;
  /** 危险操作：清除全部复习历史并重建 New 状态（stateId 会更换）。 */
  resetProgress: (cardId: string) => Promise<boolean>;
  deleteCard: (cardId: string) => Promise<boolean>;
  bulkEnqueue: (cardIds: string[]) => Promise<boolean>;
  bulkSetSuspended: (cardIds: string[], suspended: boolean) => Promise<boolean>;
  bulkDelete: (cardIds: string[]) => Promise<boolean>;
  /** 手动新建一张卡片（走后端 save_anki_cards，可选立即入队 FSRS）。 */
  createCard: (input: NewLibraryCardInput) => Promise<boolean>;
  /** 选择本地 .apkg 并导入卡片库（后端 import_apkg_to_library，与命令面板同一条链路）。 */
  importApkg: (options?: ImportApkgOptions) => Promise<ApkgImportOutcome>;
  /** 选择本地 CSV/TSV 并解析导入卡片库（RFC 4180 + Anki 导出的文本表格）。 */
  importCsv: (options?: ImportCsvOptions) => Promise<CsvImportOutcome>;
  reset: () => void;
}

export interface ImportApkgOptions {
  file?: File;
}

export interface ImportCsvOptions {
  targetDeck?: string;
  file?: File;
  rawText?: string;
}

export interface NewLibraryCardInput {
  front: string;
  back: string;
  tags?: string[];
  /** 可选目标牌组（如 `英语::词汇`）；留空为未分组 */
  deckName?: string;
  /** 卡片类型：Basic（问答）或 Cloze（挖空）；省略时若正面含有效挖空则自动按 Cloze 处理 */
  noteType?: 'Basic' | 'Cloze';
  /** 可选自定义模板 ID（S2-11） */
  templateId?: string | null;
  /** 建完立刻进入复习队列（默认 true，否则新卡不会出现在到期队列里） */
  enqueue?: boolean;
}

export type ApkgImportOutcome =
  | {
      status: 'imported';
      importedCards: number;
      /** 导入时同步加入 FSRS 复习的卡数（后端 reviewEnqueue.enqueued） */
      reviewEnqueued: number;
      /** 其中沿用 Anki 复习进度（非新卡）建档的卡数 */
      reviewWithHistory: number;
    }
  | { status: 'canceled' }
  | { status: 'failed'; error: string };

export type CsvImportOutcome =
  | {
      status: 'imported';
      importedCards: number;
      reviewEnqueued: number;
      skippedRows: number;
    }
  | { status: 'canceled' }
  | { status: 'failed'; error: string };

const initialState = {
  items: [] as AnkiLibraryCard[],
  total: 0,
  page: 1,
  pageSize: FLASHCARDS_LIBRARY_PAGE_SIZE,
  searchInput: '',
  query: '',
  loading: false,
  loadError: null as string | null,
  actionError: null as string | null,
  busyCardId: null as string | null,
  creating: false,
  importing: false,
  bulkBusy: false,
  loaded: false,
  statusFilter: 'all' as LibraryStatusFilter,
  sortKey: 'default' as LibrarySortKey,
  sortDir: 'asc' as LibrarySortDir,
  statusCounts: null as AnkiLibraryStatusCounts | null,
  deckFilter: null as string | null,
  decks: null as AnkiLibraryDeckCount[] | null,
};

/** 名称是否带有可识别的（短字母数字）扩展名，如 `notes.pdf`；不透明 ID 返回 false。 */
function hasRecognizableExtension(fileName: string): boolean {
  return /\.[a-z0-9]{1,8}$/i.test(fileName);
}

/** APKG 是 ZIP 容器：读取落盘文件头 4 字节核对 `PK\x03\x04`。读取失败视为不合法。 */
async function stagedFileLooksLikeZip(
  openFile: typeof import('@tauri-apps/plugin-fs').open,
  stagedPath: string,
): Promise<boolean> {
  try {
    const handle = await openFile(stagedPath, { read: true });
    try {
      const header = new Uint8Array(4);
      const read = await handle.read(header);
      return (
        read === 4 &&
        header[0] === 0x50 &&
        header[1] === 0x4b &&
        header[2] === 0x03 &&
        header[3] === 0x04
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

export const useFlashcardsLibraryStore = create<FlashcardsLibraryState>((set, get) => {
  let requestId = 0;

  const runMutation = async (
    cardId: string,
    mutation: (card: AnkiLibraryCard) => Promise<unknown>,
  ): Promise<boolean> => {
    const card = get().items.find((item) => item.id === cardId);
    if (!card) {
      set({ actionError: i18n.t('flashcards:library.cardNotFound') });
      return false;
    }
    set({ busyCardId: cardId, actionError: null });
    try {
      await mutation(card);
      requestFlashcardsDueRefresh();
      await get().refresh();
      return true;
    } catch (error) {
      set({
        actionError: getErrorMessage(error) || i18n.t('flashcards:library.actionFailed'),
      });
      return false;
    } finally {
      if (get().busyCardId === cardId) set({ busyCardId: null });
    }
  };

  /**
   * 批量操作：逐卡执行、聚合失败，只在结束后刷新一次列表。
   * 目标卡不在当前页时按失败处理（与 runMutation 的 fail-closed 语义一致）。
   */
  const runBulkMutation = async (
    cardIds: string[],
    mutation: (card: AnkiLibraryCard) => Promise<unknown>,
  ): Promise<boolean> => {
    const ids = Array.from(new Set(cardIds));
    if (ids.length === 0) return true;
    const byId = new Map(get().items.map((item) => [item.id, item]));
    const cards = ids
      .map((id) => byId.get(id))
      .filter((item): item is AnkiLibraryCard => Boolean(item));
    if (cards.length === 0) {
      set({ actionError: i18n.t('flashcards:library.cardNotFound') });
      return false;
    }
    set({ bulkBusy: true, actionError: null });
    let failed = ids.length - cards.length;
    let lastError: string | null = null;
    try {
      for (const card of cards) {
        try {
          await mutation(card);
        } catch (error) {
          failed += 1;
          lastError = getErrorMessage(error) || null;
        }
      }
      requestFlashcardsDueRefresh();
      await get().refresh();
      if (failed > 0) {
        set({
          actionError: i18n.t('flashcards:library.bulkPartialFailure', {
            failed,
            total: ids.length,
            message: lastError ?? i18n.t('flashcards:library.actionFailed'),
          }),
        });
        return false;
      }
      return true;
    } finally {
      set({ bulkBusy: false });
    }
  };

  return {
    ...initialState,

    setSearchInput: (value) => set({ searchInput: value }),
    // 筛选 / 排序在服务端执行：变化后回到第 1 页重新拉取
    setStatusFilter: (filter) => {
      if (get().statusFilter === filter) return;
      set({ statusFilter: filter, page: 1 });
      if (get().loaded) void get().load(get().query, 1);
    },
    setDeckFilter: (deck) => {
      if (get().deckFilter === deck) return;
      set({ deckFilter: deck, page: 1 });
      if (get().loaded) void get().load(get().query, 1);
    },
    toggleSort: (key) => {
      const { sortKey, sortDir } = get();
      if (sortKey === key) {
        set({ sortDir: sortDir === 'asc' ? 'desc' : 'asc', page: 1 });
      } else {
        set({ sortKey: key, sortDir: DEFAULT_SORT_DIR[key], page: 1 });
      }
      if (get().loaded) void get().load(get().query, 1);
    },
    clearSort: () => {
      set({ sortKey: 'default', sortDir: 'asc', page: 1 });
      if (get().loaded) void get().load(get().query, 1);
    },
    clearFilters: () => {
      set({
        statusFilter: 'all',
        deckFilter: null,
        sortKey: 'default',
        sortDir: 'asc',
        searchInput: '',
        query: '',
        page: 1,
        actionError: null,
      });
      return get().load('', 1);
    },
    clearActionError: () => set({ actionError: null }),

    load: async (query = get().query, page = get().page) => {
      const normalizedQuery = query.trim();
      const requestedPage = Math.max(1, Math.trunc(page));
      const currentRequest = ++requestId;
      set({ loading: true, loadError: null });
      try {
        const { statusFilter, deckFilter, sortKey, sortDir, pageSize } = get();
        const effectivePageSize = pageSize > 0 ? pageSize : FLASHCARDS_LIBRARY_PAGE_SIZE;
        const response: AnkiLibraryListResponse = await listAnkiLibraryCards({
          search: normalizedQuery || undefined,
          page: requestedPage,
          page_size: effectivePageSize,
          status: statusFilter === 'all' ? undefined : statusFilter,
          sort: sortKey === 'default' ? undefined : sortKey,
          sort_desc: sortKey === 'default' ? undefined : sortDir === 'desc',
          deck: deckFilter ?? undefined,
          include_decks: true,
        });
        if (currentRequest !== requestId) return false;

        const total = Math.max(0, response.total ?? 0);
        const lastPage = Math.max(1, Math.ceil(total / effectivePageSize));
        if (requestedPage > lastPage) {
          set({ page: lastPage, query: normalizedQuery, loading: false });
          return get().load(normalizedQuery, lastPage);
        }

        set({
          items: Array.isArray(response.items) ? response.items : [],
          total,
          page: requestedPage,
          query: normalizedQuery,
          loading: false,
          loaded: true,
          statusCounts: response.statusCounts ?? null,
          decks: Array.isArray(response.decks) ? response.decks : null,
        });
        return true;
      } catch (error) {
        if (currentRequest !== requestId) return false;
        set({
          items: [],
          total: 0,
          loading: false,
          loaded: true,
          loadError: getErrorMessage(error) || i18n.t('flashcards:library.loadFailed'),
        });
        return false;
      }
    },

    refresh: () => get().load(get().query, get().page),

    submitSearch: (query = get().searchInput) => {
      const normalizedQuery = query.trim();
      set({ searchInput: query, query: normalizedQuery, page: 1, actionError: null });
      return get().load(normalizedQuery, 1);
    },

    goToPage: (page) => {
      if (!Number.isFinite(page)) return Promise.resolve(false);
      const effectivePageSize = get().pageSize > 0 ? get().pageSize : FLASHCARDS_LIBRARY_PAGE_SIZE;
      const lastPage = Math.max(1, Math.ceil(get().total / effectivePageSize));
      const boundedPage = Math.min(lastPage, Math.max(1, Math.trunc(page)));
      if (boundedPage === get().page) return Promise.resolve(false);
      set({ page: boundedPage });
      return get().load(get().query, boundedPage);
    },

    setPageSize: (nextPageSize) => {
      if (!FLASHCARDS_LIBRARY_PAGE_SIZE_OPTIONS.includes(nextPageSize as LibraryPageSize)) {
        return Promise.resolve(false);
      }
      if (nextPageSize === get().pageSize) return Promise.resolve(false);
      set({ pageSize: nextPageSize, page: 1 });
      return get().load(get().query, 1);
    },

    enqueueCard: (cardId) => runMutation(cardId, (card) => enqueueAnkiLibraryCard(card.id)),

    setCardSuspended: (cardId, suspended) => runMutation(cardId, async (card) => {
      if (!card.stateId) throw new Error(i18n.t('flashcards:library.missingState'));
      return suspended
        ? suspendFsrsCard(card.stateId)
        : unsuspendFsrsCard(card.stateId);
    }),

    updateCard: (cardId, patch, template) => runMutation(
      cardId,
      // 未提供 template 时保持两参调用形态（既有调用方/断言不感知新参数）
      (card) => (template !== undefined
        ? updateAnkiLibraryCard(card, patch, template)
        : updateAnkiLibraryCard(card, patch)),
    ),

    undoLastReview: (cardId) => runMutation(cardId, async (card) => {
      const logId = card.latestReview?.undoable ? card.latestReview.logId : null;
      if (!card.stateId || !logId) {
        throw new Error(i18n.t('flashcards:library.undoUnavailable'));
      }
      return undoFsrsLastReview(card.stateId, logId);
    }),

    resetProgress: (cardId) => runMutation(cardId, async (card) => {
      if (!card.stateId) throw new Error(i18n.t('flashcards:library.missingState'));
      return resetFsrsCardProgress(card.stateId);
    }),

    deleteCard: (cardId) => runMutation(cardId, (card) => deleteAnkiCard(card.id)),

    bulkEnqueue: (cardIds) => runBulkMutation(cardIds, async (card) => {
      if (card.enqueued) return;
      await enqueueAnkiLibraryCard(card.id);
    }),

    bulkSetSuspended: (cardIds, suspended) => runBulkMutation(cardIds, async (card) => {
      if (!card.enqueued || card.suspended === suspended) return;
      if (!card.stateId) throw new Error(i18n.t('flashcards:library.missingState'));
      await (suspended ? suspendFsrsCard(card.stateId) : unsuspendFsrsCard(card.stateId));
    }),

    bulkDelete: (cardIds) => runBulkMutation(cardIds, (card) => deleteAnkiCard(card.id)),

    createCard: async ({ front, back, tags = [], deckName, noteType, templateId, enqueue = true }) => {
      const trimmedFront = front.trim();
      const trimmedBack = back.trim();
      const trimmedDeck = deckName?.trim();
      const trimmedTemplateId = templateId?.trim() || undefined;
      const isCloze = noteType === 'Cloze' || (!noteType && hasValidCloze(trimmedFront));
      if (!trimmedFront || (!isCloze && !trimmedBack)) {
        set({ actionError: i18n.t('flashcards:library.create.incomplete') });
        return false;
      }
      if (isCloze && !hasValidCloze(trimmedFront)) {
        set({ actionError: i18n.t('flashcards:session.invalidClozeEdit') });
        return false;
      }
      set({ creating: true, actionError: null });
      try {
        const { ankiApiAdapter } = await import('@/services/ankiApiAdapter');
        const cardPayload = isCloze
          ? {
              front: trimmedFront,
              back: trimmedBack,
              text: trimmedFront,
              extra_fields: {
                Text: trimmedFront,
                ...(trimmedBack ? { Extra: trimmedBack } : {}),
                ...(trimmedDeck ? { _deck: trimmedDeck } : {}),
              },
              tags,
              images: [] as string[],
              ...(trimmedTemplateId ? { template_id: trimmedTemplateId } : {}),
            }
          : {
              front: trimmedFront,
              back: trimmedBack,
              tags,
              images: [] as string[],
              ...(trimmedDeck ? { extra_fields: { _deck: trimmedDeck } } : {}),
              ...(trimmedTemplateId ? { template_id: trimmedTemplateId } : {}),
            };
        const response = await ankiApiAdapter.saveAnkiCards({
          cards: [cardPayload],
          ...((trimmedDeck || trimmedTemplateId)
            ? {
                options: {
                  deck_name: trimmedDeck || 'Default',
                  note_type: isCloze ? 'Cloze' : 'Basic',
                  enable_images: false,
                  max_cards_per_source: 1,
                  max_cards_per_mistake: 1,
                  ...(trimmedTemplateId ? { template_id: trimmedTemplateId } : {}),
                },
              }
            : {}),
        });
        const savedId = response.savedIds?.[0]
          ?? response.cardIdMappings?.[0]?.persistedId
          ?? null;
        if (!savedId) {
          const failure = response.failed?.[0]?.error;
          throw new Error(failure || i18n.t('flashcards:library.create.failed'));
        }
        if (enqueue) {
          // 入队失败不吞：卡已落库，但用户需要知道它还没进复习队列
          await enqueueAnkiLibraryCard(savedId);
        }
        requestFlashcardsDueRefresh();
        await get().refresh();
        return true;
      } catch (error) {
        set({
          actionError: getErrorMessage(error) || i18n.t('flashcards:library.create.failed'),
        });
        return false;
      } finally {
        set({ creating: false });
      }
    },

    importApkg: async (options) => {
      set({ importing: true, actionError: null });
      try {
        const [{ fileManager, isVirtualUri, extractFileName }, { invoke }] = await Promise.all([
          import('@/utils/fileManager'),
          import('@tauri-apps/api/core'),
        ]);
        let path: string | null = null;
        if (options?.file) {
          const pickedFile = options.file;
          const lower = pickedFile.name.toLowerCase();
          if (!lower.endsWith('.apkg') && hasRecognizableExtension(pickedFile.name)) {
            const message = i18n.t('flashcards:library.import.notApkg');
            set({ actionError: message });
            return { status: 'failed' as const, error: message };
          }
          const stageRes = await fetch(`/api/files/stage?name=${encodeURIComponent(pickedFile.name)}`, {
            method: 'POST',
            headers: {
              'Content-Type': pickedFile.type || 'application/octet-stream',
              'X-File-Name': encodeURIComponent(pickedFile.name),
            },
            body: pickedFile,
          });
          if (!stageRes.ok) {
            throw new Error(`Stage APKG upload failed (${stageRes.status})`);
          }
          const staged = (await stageRes.json()) as { path?: string };
          path = staged.path ?? null;
        } else {
          path = await fileManager.pickSingleFile({
            title: i18n.t('flashcards:library.import.pickTitle'),
            filters: [{ name: 'Anki Deck', extensions: ['apkg'] }],
          });
        }
        if (!path) return { status: 'canceled' as const };

        // Android SAF 选择器返回 content:// 等虚拟 URI（不是文件系统路径），而
        // import_apkg_to_library 只认真实路径：先经后端 copy_file（unified 层支持
        // 虚拟源、自动建父目录、SHA 回读校验）落盘到应用私有 tmp，再走同一条导入
        // 命令；桌面端真实路径保持原逻辑直传。
        let importPath = path;
        let stagedPath: string | null = null;
        let removeStaged: ((path: string) => Promise<void>) | null = null;
        if (isVirtualUri(path)) {
          // SAF document ID 解码后可能含 `:` 等文件名非法字符（如 `abc:deck.apkg`），
          // 统一净化为 `_` 再落盘
          // Control bytes are intentionally rejected in a filesystem name.
          // eslint-disable-next-line no-control-regex
          const fileName = (extractFileName(path) || '').replace(/[\\/:*?<>|\x00-\x1f]/g, '_');
          // 多数 Android provider 返回不透明 ID（`msf:1234`、`/document/446`），名称
          // 里根本没有扩展名：此时无法按名判断，改为落盘后按内容（ZIP 魔数）校验，
          // 真正的格式错误再由后端 APKG 解析器报出。只有名称带着别的扩展名时才前置拒绝。
          const hasApkgName = fileName.toLowerCase().endsWith('.apkg');
          if (!hasApkgName && hasRecognizableExtension(fileName)) {
            const message = i18n.t('flashcards:library.import.notApkg');
            set({ actionError: message });
            return { status: 'failed' as const, error: message };
          }
          const [{ copyFile: copyViaBackend }, { appDataDir, join }, { mkdir, remove, open }] =
            await Promise.all([
              import('@/utils/chatApi'),
              import('@tauri-apps/api/path'),
              import('@tauri-apps/plugin-fs'),
            ]);
          const stagedDir = await join(await appDataDir(), 'tmp_apkg_import');
          await mkdir(stagedDir, { recursive: true });
          stagedPath = await join(
            stagedDir,
            hasApkgName ? fileName : `import_${Date.now()}.apkg`,
          );
          await copyViaBackend(path, stagedPath);
          removeStaged = remove;
          importPath = stagedPath;
          if (!hasApkgName && !(await stagedFileLooksLikeZip(open, stagedPath))) {
            try {
              await remove(stagedPath);
            } catch { /* ignore */ }
            stagedPath = null;
            const message = i18n.t('flashcards:library.import.notApkg');
            set({ actionError: message });
            return { status: 'failed' as const, error: message };
          }
        }

        try {
          const result = await invoke<{
            importedCards?: number;
            reviewEnqueue?: { enqueued?: number; withHistory?: number; suspended?: number };
          }>('import_apkg_to_library', { path: importPath });
          requestFlashcardsDueRefresh();
          await get().refresh();
          return {
            status: 'imported' as const,
            importedCards: result?.importedCards ?? 0,
            reviewEnqueued: result?.reviewEnqueue?.enqueued ?? 0,
            reviewWithHistory: result?.reviewEnqueue?.withHistory ?? 0,
          };
        } finally {
          if (stagedPath && removeStaged) {
            // 临时落盘清理（best-effort；失败仅残留 tmp 文件，不影响导入结果）
            try {
              await removeStaged(stagedPath);
            } catch { /* ignore */ }
          }
        }
      } catch (error) {
        const message = getErrorMessage(error) || i18n.t('flashcards:library.import.failed');
        set({ actionError: message });
        return { status: 'failed' as const, error: message };
      } finally {
        set({ importing: false });
      }
    },

    importCsv: async (options) => {
      set({ importing: true, actionError: null });
      try {
        const [{ fileManager }, { invoke }, { ankiApiAdapter }, { parseFlashcardsFromCsv }] =
          await Promise.all([
            import('@/utils/fileManager'),
            import('@tauri-apps/api/core'),
            import('@/services/ankiApiAdapter'),
            import('../library/csvFlashcards'),
          ]);

        let rawText: string | null = null;
        if (typeof options?.rawText === 'string') {
          rawText = options.rawText;
        } else if (options?.file) {
          rawText = typeof (options.file as { text?: unknown }).text === 'function'
            ? await options.file.text()
            : typeof FileReader !== 'undefined'
              ? await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
                  reader.onerror = () => reject(reader.error ?? new Error('Failed to read CSV file'));
                  reader.readAsText(options.file as Blob);
                })
              : await new Response(options.file).text();
        } else {
          const path = await fileManager.pickSingleFile({
            title: i18n.t('flashcards:library.import.csvPickTitle'),
            filters: [{ name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] }],
          });
          if (!path) return { status: 'canceled' as const };
          rawText = await fileManager.readTextFile(path);
        }

        const parsed = parseFlashcardsFromCsv(rawText);
        if (parsed.cards.length === 0) {
          const message = i18n.t('flashcards:library.import.csvEmpty');
          set({ actionError: message });
          return { status: 'failed' as const, error: message };
        }

        const fallbackTargetDeck = options?.targetDeck?.trim() || '';
        const groups = new Map<
          string,
          { deck: string; noteType: 'Basic' | 'Cloze'; cards: typeof parsed.cards }
        >();
        for (const card of parsed.cards) {
          const resolvedDeck = card.deck || fallbackTargetDeck;
          const key = `${resolvedDeck}\0${card.noteType}`;
          const existing = groups.get(key);
          if (existing) {
            existing.cards.push(card);
          } else {
            groups.set(key, { deck: resolvedDeck, noteType: card.noteType, cards: [card] });
          }
        }

        const savedIds: string[] = [];
        for (const group of groups.values()) {
          const cardsPayload = group.cards.map((card) =>
            card.noteType === 'Cloze'
              ? {
                  front: card.front,
                  back: card.back,
                  text: card.front,
                  extra_fields: {
                    Text: card.front,
                    ...(card.back ? { Extra: card.back } : {}),
                  },
                  tags: card.tags,
                  images: [] as string[],
                }
              : {
                  front: card.front,
                  back: card.back,
                  tags: card.tags,
                  images: [] as string[],
                },
          );

          const response = await ankiApiAdapter.saveAnkiCards({
            cards: cardsPayload,
            ...(group.deck
              ? {
                  options: {
                    deck_name: group.deck,
                    note_type: group.noteType,
                    enable_images: false,
                    max_cards_per_source: cardsPayload.length,
                    max_cards_per_mistake: cardsPayload.length,
                  },
                }
              : {}),
          });

          const groupIds = (
            response.savedIds?.length
              ? response.savedIds
              : response.cardIdMappings?.map((mapping) => mapping.persistedId) ?? []
          ).filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
          savedIds.push(...groupIds);

          if (groupIds.length === 0 && response.failed?.length) {
            throw new Error(response.failed[0].error || i18n.t('flashcards:library.import.csvFailed'));
          }
        }

        if (savedIds.length === 0) {
          const message = i18n.t('flashcards:library.import.csvFailed');
          set({ actionError: message });
          return { status: 'failed' as const, error: message };
        }

        const enqueueResult = await invoke<{ states?: unknown[] } | null>('fsrs_enqueue_cards', {
          ankiCardIds: savedIds,
        });
        const reviewEnqueued = Array.isArray(enqueueResult?.states)
          ? enqueueResult.states.length
          : savedIds.length;

        requestFlashcardsDueRefresh();
        await get().refresh();
        return {
          status: 'imported' as const,
          importedCards: savedIds.length,
          reviewEnqueued,
          skippedRows: parsed.skippedRows,
        };
      } catch (error) {
        const message = getErrorMessage(error) || i18n.t('flashcards:library.import.csvFailed');
        set({ actionError: message });
        return { status: 'failed' as const, error: message };
      } finally {
        set({ importing: false });
      }
    },

    reset: () => {
      requestId += 1;
      set({ ...initialState });
    },
  };
});
