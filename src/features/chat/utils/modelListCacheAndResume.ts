/** Model discovery is endpoint-scoped. Never persist a provider or connection object. */
export const MODEL_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MODEL_LIST_CACHE_STORAGE_KEY = 'deepstudent:model-list-cache';

export function normalizeProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export interface ModelListCacheEntry {
  ids: string[];
  updatedAt: number;
  stale: boolean;
}

type CacheStorage = Pick<Storage, 'getItem' | 'setItem'>;
type StoredEntry = Pick<ModelListCacheEntry, 'ids' | 'updatedAt'>;

function defaultCacheStorage(): CacheStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export class ModelListCacheStore {
  private entries = new Map<string, StoredEntry>();
  private refreshing = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: CacheStorage | undefined = defaultCacheStorage(),
    private readonly now: () => number = Date.now,
    private readonly ttlMs = MODEL_LIST_CACHE_TTL_MS,
  ) {
    try {
      const raw: unknown = JSON.parse(storage?.getItem(MODEL_LIST_CACHE_STORAGE_KEY) ?? '[]');
      if (Array.isArray(raw)) {
        for (const pair of raw) {
          if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
          const entry = pair[1];
          if (!entry || !Array.isArray(entry.ids) || !entry.ids.every((id: unknown) => typeof id === 'string')
            || !Number.isFinite(entry.updatedAt)) continue;
          // Project fields explicitly, including on read: old data cannot carry credentials forward.
          this.entries.set(normalizeProviderBaseUrl(pair[0]), { ids: [...entry.ids], updatedAt: entry.updatedAt });
        }
      }
    } catch { /* Unavailable storage must not block settings. */ }
  }

  read(baseUrl: string): ModelListCacheEntry | null {
    const entry = this.entries.get(normalizeProviderBaseUrl(baseUrl));
    return entry ? { ids: [...entry.ids], updatedAt: entry.updatedAt, stale: this.now() - entry.updatedAt >= this.ttlMs } : null;
  }

  write(baseUrl: string, ids: readonly string[]): void {
    const key = normalizeProviderBaseUrl(baseUrl);
    if (!key) return;
    this.entries.set(key, { ids: ids.filter((id) => typeof id === 'string'), updatedAt: this.now() });
    this.persist();
  }

  evictByBaseUrl(baseUrl: string): void {
    this.entries.delete(normalizeProviderBaseUrl(baseUrl));
    // Invalidate an in-flight refresh so it cannot resurrect a removed provider.
    this.refreshing.delete(normalizeProviderBaseUrl(baseUrl));
    this.persist();
  }

  /** Return stale candidates synchronously; refresh only missing/expired endpoints, silently. */
  openSettings(baseUrls: readonly string[], fetchModels: (baseUrl: string) => Promise<readonly string[]>): Map<string, ModelListCacheEntry | null> {
    const candidates = new Map<string, ModelListCacheEntry | null>();
    for (const baseUrl of baseUrls) {
      const key = normalizeProviderBaseUrl(baseUrl);
      const cached = this.read(key);
      candidates.set(key, cached);
      if (key && (!cached || cached.stale) && !this.refreshing.has(key)) {
        const job = Promise.resolve().then(() => fetchModels(key)).then((ids) => {
          if (this.refreshing.get(key) === job) this.write(key, ids);
        }).catch(() => { /* Background discovery never notifies. */ }).finally(() => {
          if (this.refreshing.get(key) === job) this.refreshing.delete(key);
        });
        this.refreshing.set(key, job);
      }
    }
    return candidates;
  }

  async waitForRefreshes(): Promise<void> {
    await Promise.all(this.refreshing.values());
  }

  private persist(): void {
    try { this.storage?.setItem(MODEL_LIST_CACHE_STORAGE_KEY, JSON.stringify([...this.entries])); }
    catch { /* Keep the in-memory cache if storage is full or disabled. */ }
  }
}

export interface ResumableMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoning?: string;
  interrupted?: boolean;
  interruptReason?: string;
}

/** Model-facing instruction, not UI copy. */
export const CONTINUE_INSTRUCTION = '接着上面继续写，不要重复已写内容，不要重新开头。';

/** Persist this returned row through the caller's existing database write path. */
export function buildInterruptedMessage<T extends ResumableMessage>(message: T, reason: string, userAborted = false): T {
  if (userAborted) return { ...message };
  return { ...message, interrupted: true, interruptReason: reason };
}

export function buildContinuationPayload(systemPrompt: string, historyWithPartialAssistant: readonly ResumableMessage[]) {
  return {
    messages: [
      { role: 'system' as const, content: systemPrompt },
      ...historyWithPartialAssistant.map(({ role, content }) => ({ role, content })),
      { role: 'user' as const, content: CONTINUE_INSTRUCTION },
    ],
    tools: [],
  };
}

/** Update the original row, never create a second assistant bubble. */
export function appendContinuationDelta<T extends ResumableMessage>(message: T, contentDelta: string, reasoningDelta = '', completed = false): T {
  const result = { ...message, content: message.content + contentDelta };
  if (reasoningDelta) result.reasoning = (message.reasoning ?? '') + reasoningDelta;
  if (completed) {
    delete result.interrupted;
    delete result.interruptReason;
  }
  return result;
}

export type RetryOrForkAction =
  | { action: 'continue_interrupted'; messageId: string }
  | { action: 'regenerate_last'; userPromptMessageId: string; assistantMessageId: string }
  | { action: 'require_fork'; forkUpToMessageId: string };

export function resolveRetryOrForkAction(messages: readonly ResumableMessage[], targetMessageId: string): RetryOrForkAction {
  const index = messages.findIndex((message) => message.id === targetMessageId);
  const target = messages[index];
  if (!target || target.role !== 'assistant') throw new Error('invalid_assistant_message');
  if (target.interrupted) return { action: 'continue_interrupted', messageId: target.id };
  if (messages.slice(index + 1).some((message) => message.role === 'assistant')) {
    return { action: 'require_fork', forkUpToMessageId: target.id };
  }
  // A later user/tool message is also history: regenerating must not delete it.
  if (index !== messages.length - 1) return { action: 'require_fork', forkUpToMessageId: target.id };
  const user = messages.slice(0, index).reverse().find((message) => message.role === 'user');
  if (!user) throw new Error('missing_user_prompt');
  return { action: 'regenerate_last', userPromptMessageId: user.id, assistantMessageId: target.id };
}

export type SessionKey = string | number;

/** Views own messages, queues and pending cards; the input draft deliberately stays outside. */
export class ParkedSessionViewManager<TView extends object> {
  private readonly views = new Map<SessionKey, TView>();
  private readonly loaded = new Set<SessionKey>();
  private readonly pending = new Map<SessionKey, Promise<TView>>();
  private readonly loadPatches = new Map<SessionKey, Partial<TView>>();
  runningIds: SessionKey[] = [];

  constructor(public activeSessionKey: SessionKey, private readonly createEmptyView: () => TView, initialView?: TView) {
    if (initialView) {
      this.views.set(activeSessionKey, initialView);
      this.loaded.add(activeSessionKey);
    }
  }

  readView(sessionKey: SessionKey): TView {
    let view = this.views.get(sessionKey);
    if (!view) {
      view = this.createEmptyView();
      this.views.set(sessionKey, view);
    }
    return view;
  }

  writeView(sessionKey: SessionKey, patch: Partial<TView>): void {
    this.views.set(sessionKey, { ...this.readView(sessionKey), ...patch });
    if (!this.loaded.has(sessionKey)) {
      this.loadPatches.set(sessionKey, { ...this.loadPatches.get(sessionKey), ...patch });
    }
  }

  async switchSession(nextSessionKey: SessionKey, loadFromDb: (key: SessionKey) => Promise<TView>): Promise<TView> {
    this.activeSessionKey = nextSessionKey;
    if (this.loaded.has(nextSessionKey)) return this.readView(nextSessionKey);
    const existing = this.pending.get(nextSessionKey);
    if (existing) return existing;
    this.readView(nextSessionKey);
    const job = Promise.resolve().then(() => loadFromDb(nextSessionKey)).then((view) => {
      const merged = { ...view, ...this.loadPatches.get(nextSessionKey) };
      this.views.set(nextSessionKey, merged);
      this.loaded.add(nextSessionKey);
      return merged;
    }).catch((error: unknown) => {
      this.views.delete(nextSessionKey);
      throw error;
    }).finally(() => {
      this.pending.delete(nextSessionKey);
      this.loadPatches.delete(nextSessionKey);
    });
    this.pending.set(nextSessionKey, job);
    return job;
  }

  canMutateSessionLifecycle(targetSessionKey: SessionKey): boolean {
    return !this.runningIds.includes(targetSessionKey);
  }

  shouldClearDraftOnSend(targetSessionKey: SessionKey): boolean {
    return targetSessionKey === this.activeSessionKey;
  }
}
