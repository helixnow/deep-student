/**
 * Cross-Plugin Semantic Anchor Reveal Router & Backlink Graph (`ctx.ui.anchors` / `kernel.anchors`).
 *
 * Implements:
 * 1. `<50ms` in-memory fast-path routing to mounted viewers (`'exact-focused'` > `'exact-mounted'`).
 * 2. Closed-pane auto-split fallback (`splitIfClosed !== false`) with a `1500ms` pending reveal flush.
 * 3. Live in-memory + optional Tauri SQLite (`vfs_anchor_edges_*`) backlink edge graph.
 */
import {
  buildAnchorEdgeRecord,
  normalizePersistedAnchorEdgeRecord,
  parseSemanticAnchor,
  sanitizeSemanticAnchor,
  type AnchorEdgeRecord,
  type AnchorEdgeSourceKind,
  type AnchorEdgeUpsertInput,
  type SemanticAnchor,
  type SemanticAnchorKind,
} from '../contracts/interop';
import type { UiDisposer } from '../plugin';
import { dispatchTypedEvent } from '@/events/registry';

export const DS_ANCHOR_EDGES_CHANGED_EVENT = 'ds:anchor-edges-changed';
const DEFAULT_PENDING_REVEAL_TIMEOUT_MS = 1500;

export type AnchorMatchQuality = 'exact-focused' | 'exact-mounted' | false;

export interface AnchorRevealContext {
  pulse: boolean;
  signal?: AbortSignal;
}

export interface AnchorRevealHandler<K extends SemanticAnchorKind = SemanticAnchorKind> {
  /** Synchronous check (<1ms): does this mounted viewer currently hold `anchor.resourceId` (or `aliasResourceId`)? */
  canHandle: (anchor: Extract<SemanticAnchor, { kind: K }>) => AnchorMatchQuality;
  /** Scrolls/seeks to the exact sub-resource coordinate and triggers highlight pulse if `ctx.pulse` is true. */
  reveal: (
    anchor: Extract<SemanticAnchor, { kind: K }>,
    ctx: AnchorRevealContext,
  ) => Promise<boolean> | boolean;
}

export interface AnchorRevealOptions {
  /** Open in a split/adjacent pane if no currently mounted pane holds this resource (default: true). */
  splitIfClosed?: boolean;
  /** Trigger visual pulse on the revealed target (default: true). */
  pulse?: boolean;
  /** Optional cancellation signal forwarded to reveal handlers. */
  signal?: AbortSignal;
}

export type AnchorRevealOutcome =
  | 'revealed-in-open-pane'
  | 'opened-and-revealed'
  | 'opened-via-host'
  | 'invalid-anchor'
  | 'unhandled';

export interface AnchorRevealResult {
  ok: boolean;
  outcome: AnchorRevealOutcome;
  elapsedMs: number;
}

export interface AnchorEdgesChangedDetail {
  targetResourceIds: string[];
  sourceResourceId?: string;
}

export interface AnchorEdgesAdapter {
  upsert: (edges: AnchorEdgeRecord[]) => Promise<void>;
  deleteBySource: (params: {
    sourceKind: string;
    sourceResourceId: string;
    keepEdgeIds?: string[];
  }) => Promise<void>;
  queryByTarget: (params: {
    targetResourceIds: string[];
    targetKind?: string;
  }) => Promise<AnchorEdgeRecord[]>;
}

export type OpenAnchorAdapter = (
  anchor: SemanticAnchor,
  options: { splitIfClosed: boolean },
) => Promise<boolean> | boolean;

export interface UiAnchorsHandle {
  registerAnchorRevealHandler<K extends SemanticAnchorKind>(
    kind: K,
    handler: AnchorRevealHandler<K>,
  ): UiDisposer;
  reveal(target: SemanticAnchor | string, options?: AnchorRevealOptions): Promise<AnchorRevealResult>;
  upsertAnchorEdges(
    edges: readonly AnchorEdgeUpsertInput[],
  ): Promise<{ upserted: number; edges: AnchorEdgeRecord[] }>;
  pruneAnchorEdgesBySource(params: {
    sourceKind: AnchorEdgeSourceKind | string;
    sourceResourceId: string;
    keepEdgeIds?: readonly string[];
  }): Promise<{ deleted: number }>;
  queryAnchorEdgesByTarget(params: {
    targetResourceIds: readonly string[];
    targetKind?: SemanticAnchorKind | string;
  }): Promise<AnchorEdgeRecord[]>;
  subscribeAnchorEdgesChanged(listener: (detail: AnchorEdgesChangedDetail) => void): UiDisposer;
}

interface RegisteredHandlerEntry {
  readonly seq: number;
  readonly kind: SemanticAnchorKind;
  readonly handler: AnchorRevealHandler<SemanticAnchorKind>;
  active: boolean;
  readonly lifetime: AbortController;
}

interface PendingWaiterOutcome {
  claimed: boolean;
  revealed: boolean;
}

interface PendingRevealWaiter {
  readonly anchor: SemanticAnchor;
  readonly pulse: boolean;
  readonly signal?: AbortSignal;
  claimed: boolean;
  readonly failedHandlers: Set<number>;
  promise: Promise<PendingWaiterOutcome>;
  settle: (outcome: PendingWaiterOutcome) => void;
  cancel: () => void;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function qualityScore(quality: AnchorMatchQuality): number {
  if (quality === 'exact-focused') return 2;
  if (quality === 'exact-mounted') return 1;
  return 0;
}

export interface AnchorRegistryOptions {
  openAnchor?: OpenAnchorAdapter;
  anchorEdges?: AnchorEdgesAdapter;
  pendingRevealTimeoutMs?: number;
  onError?: (error: unknown) => void;
}

export class AnchorRegistry implements UiAnchorsHandle {
  private nextSeq = 0;
  private readonly handlersByKind = new Map<SemanticAnchorKind, Map<number, RegisteredHandlerEntry>>();
  private readonly pendingWaiters = new Set<PendingRevealWaiter>();
  private readonly edgesById = new Map<string, AnchorEdgeRecord>();
  private readonly targetAliasByEdgeId = new Map<string, string>();
  private readonly prunedEdgeIds = new Set<string>();
  private readonly edgeListeners = new Set<(detail: AnchorEdgesChangedDetail) => void>();
  private disposed = false;

  private readonly openAnchor?: OpenAnchorAdapter;
  private readonly anchorEdgesAdapter?: AnchorEdgesAdapter;
  private readonly pendingRevealTimeoutMs: number;
  private readonly onError?: (error: unknown) => void;

  constructor(options: AnchorRegistryOptions = {}) {
    this.openAnchor = options.openAnchor;
    this.anchorEdgesAdapter = options.anchorEdges;
    this.pendingRevealTimeoutMs = options.pendingRevealTimeoutMs ?? DEFAULT_PENDING_REVEAL_TIMEOUT_MS;
    this.onError = options.onError;
  }

  registerAnchorRevealHandler<K extends SemanticAnchorKind>(
    kind: K,
    handler: AnchorRevealHandler<K>,
  ): UiDisposer {
    const seq = ++this.nextSeq;
    let bucket = this.handlersByKind.get(kind);
    if (!bucket) {
      bucket = new Map();
      this.handlersByKind.set(kind, bucket);
    }
    const entry: RegisteredHandlerEntry = {
      seq,
      kind,
      handler: handler as unknown as AnchorRevealHandler<SemanticAnchorKind>,
      active: true,
      lifetime: new AbortController(),
    };
    bucket.set(seq, entry);

    // Flush any pending closed-pane reveal waiters matching this newly mounted viewer.
    for (const waiter of this.pendingWaiters) this.tryPendingReveal(waiter);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      entry.active = false;
      entry.lifetime.abort();
      bucket?.delete(seq);
    };
  }

  private async revealWithHandler(
    entry: RegisteredHandlerEntry, anchor: SemanticAnchor, pulse: boolean, signal?: AbortSignal,
  ): Promise<boolean> {
    if (!entry.active || signal?.aborted) return false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    entry.lifetime.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    let cancel!: () => void;
    const cancelled = new Promise<boolean>(resolve => { cancel = () => resolve(false); });
    controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      return Boolean(await Promise.race([
        entry.handler.reveal(anchor, { pulse, signal: controller.signal }), cancelled,
      ])) && entry.active && !controller.signal.aborted;
    } finally {
      entry.lifetime.signal.removeEventListener('abort', abort);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancel);
    }
  }

  private tryPendingReveal(waiter: PendingRevealWaiter): void {
    if (waiter.claimed || waiter.signal?.aborted || !this.pendingWaiters.has(waiter)) return;
    waiter.claimed = true;
    void Promise.resolve().then(async () => {
      const attempted = new Set(waiter.failedHandlers);
      try {
        let entry: RegisteredHandlerEntry | null;
        while (!waiter.signal?.aborted && (entry = this.findBestHandler(waiter.anchor, attempted))) {
          attempted.add(entry.seq);
          try {
            const ok = await this.revealWithHandler(entry, waiter.anchor, waiter.pulse, waiter.signal);
            if (ok && entry.active && !waiter.signal?.aborted) {
              waiter.settle({ claimed: true, revealed: true });
              return;
            }
          } catch (error) {
            waiter.failedHandlers.add(entry.seq);
            this.onError?.(error);
          }
        }
      } finally {
        waiter.claimed = false;
      }
    });
  }

  private findBestHandler(anchor: SemanticAnchor, excluded?: ReadonlySet<number>): RegisteredHandlerEntry | null {
    const bucket = this.handlersByKind.get(anchor.kind);
    if (!bucket || bucket.size === 0) return null;

    let best: RegisteredHandlerEntry | null = null;
    let bestScore = 0;

    for (const entry of bucket.values()) {
      if (!entry.active || excluded?.has(entry.seq)) continue;
      let quality: AnchorMatchQuality = false;
      try {
        quality = entry.handler.canHandle(anchor);
      } catch (error) {
        this.onError?.(error);
        quality = false;
      }
      const score = qualityScore(quality);
      if (score === 0) continue;
      if (!best || score > bestScore || (score === bestScore && entry.seq > best.seq)) {
        best = entry;
        bestScore = score;
      }
    }

    return best;
  }

  private createPendingWaiter(
    anchor: SemanticAnchor,
    pulse: boolean,
    signal?: AbortSignal,
  ): PendingRevealWaiter {
    let settleFn!: (outcome: PendingWaiterOutcome) => void;
    const handles: {
      timer?: ReturnType<typeof setTimeout>;
      retry?: ReturnType<typeof setInterval>;
    } = {};
    const lifetime = new AbortController();
    let settled = false;

    const cleanupAbort = () => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const settle = (outcome: PendingWaiterOutcome) => {
      if (settled) return;
      settled = true;
      if (handles.timer !== undefined) clearTimeout(handles.timer);
      if (handles.retry !== undefined) clearInterval(handles.retry);
      cleanupAbort();
      this.pendingWaiters.delete(waiter);
      lifetime.abort();
      settleFn(outcome);
    };

    const onAbort = signal
      ? () => {
          settle({ claimed: false, revealed: false });
        }
      : undefined;

    const promise = new Promise<PendingWaiterOutcome>((resolve) => {
      settleFn = resolve;
    });

    const waiter: PendingRevealWaiter = {
      anchor,
      pulse,
      signal: lifetime.signal,
      claimed: false,
      failedHandlers: new Set(),
      promise,
      settle,
      cancel: () => settle({ claimed: false, revealed: false }),
    };

    if (signal?.aborted) {
      settle({ claimed: false, revealed: false });
      return waiter;
    }

    if (signal && onAbort) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    handles.timer = setTimeout(() => {
      settle({ claimed: false, revealed: false });
    }, this.pendingRevealTimeoutMs);

    this.pendingWaiters.add(waiter);
    // Viewers can register before their document/player is ready, without registering again.
    handles.retry = setInterval(() => this.tryPendingReveal(waiter), 25);
    return waiter;
  }

  async reveal(
    target: SemanticAnchor | string,
    options?: AnchorRevealOptions,
  ): Promise<AnchorRevealResult> {
    const start = nowMs();
    const elapsed = () => Math.max(0, nowMs() - start);

    const anchor =
      typeof target === 'string' ? parseSemanticAnchor(target) : sanitizeSemanticAnchor(target);
    if (!anchor) {
      return { ok: false, outcome: 'invalid-anchor', elapsedMs: 0 };
    }

    const pulse = options?.pulse !== false;
    const splitIfClosed = options?.splitIfClosed !== false;
    if (this.disposed || options?.signal?.aborted) {
      return { ok: false, outcome: 'unhandled', elapsedMs: elapsed() };
    }

    // 1. Fast path (<50ms in-memory): route directly to an already-mounted viewer.
    const attemptedHandlers = new Set<number>();
    let existing: RegisteredHandlerEntry | null;
    while ((existing = this.findBestHandler(anchor, attemptedHandlers))) {
      attemptedHandlers.add(existing.seq);
      let revealed = false;
      try {
        revealed = Boolean(
          await this.revealWithHandler(existing, anchor, pulse, options?.signal),
        );
      } catch (error) {
        this.onError?.(error);
        revealed = false;
      }
      if (revealed && existing.active && !options?.signal?.aborted && !this.disposed) {
        return {
          ok: true,
          outcome: 'revealed-in-open-pane',
          elapsedMs: elapsed(),
        };
      }
    }

    // 2. Closed-pane auto-split fallback.
    if (!splitIfClosed || !this.openAnchor || options?.signal?.aborted || this.disposed) {
      return {
        ok: false,
        outcome: 'unhandled',
        elapsedMs: elapsed(),
      };
    }

    const waiter = this.createPendingWaiter(anchor, pulse, options?.signal);

    let hostOpened = false;
    void Promise.resolve().then(() => waiter.signal?.aborted || this.disposed
      ? false : this.openAnchor!(anchor, { splitIfClosed: true })).then(
      opened => {
        hostOpened = Boolean(opened);
        this.tryPendingReveal(waiter);
        if (!hostOpened && !waiter.claimed) waiter.cancel();
      },
      error => { this.onError?.(error); waiter.cancel(); },
    );

    const pendingOutcome = await waiter.promise;
    if (pendingOutcome.claimed && pendingOutcome.revealed) {
      return {
        ok: true,
        outcome: 'opened-and-revealed',
        elapsedMs: elapsed(),
      };
    }

    if (hostOpened && !options?.signal?.aborted && !this.disposed) {
      return {
        ok: true,
        outcome: 'opened-via-host',
        elapsedMs: elapsed(),
      };
    }

    return {
      ok: false,
      outcome: 'unhandled',
      elapsedMs: elapsed(),
    };
  }

  private notifyEdgesChanged(detail: AnchorEdgesChangedDetail): void {
    for (const listener of [...this.edgeListeners]) {
      try {
        listener(detail);
      } catch (error) {
        this.onError?.(error);
      }
    }

    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      try {
        dispatchTypedEvent(DS_ANCHOR_EDGES_CHANGED_EVENT, detail);
      } catch {
        // Ignore non-browser environments where CustomEvent dispatch is unsupported.
      }
    }
  }

  async upsertAnchorEdges(
    inputs: readonly AnchorEdgeUpsertInput[],
  ): Promise<{ upserted: number; edges: AnchorEdgeRecord[] }> {
    const now = Date.now();
    const records: AnchorEdgeRecord[] = [];
    const targetIds = new Set<string>();
    let lastSourceResourceId: string | undefined;

    for (const input of inputs) {
      const sanitizedTarget = sanitizeSemanticAnchor(input?.targetAnchor);
      const preliminary = buildAnchorEdgeRecord(input, now);
      if (!preliminary) continue;
      const existing = this.edgesById.get(preliminary.edgeId);
      if (existing) {
        targetIds.add(existing.targetResourceId);
        const oldAlias = this.targetAliasByEdgeId.get(existing.edgeId);
        if (oldAlias) targetIds.add(oldAlias);
      }
      const record = existing
        ? { ...preliminary, createdAt: existing.createdAt }
        : preliminary;

      this.edgesById.set(record.edgeId, record);
      this.prunedEdgeIds.delete(record.edgeId);
      targetIds.add(record.targetResourceId);
      if (sanitizedTarget?.aliasResourceId) {
        this.targetAliasByEdgeId.set(record.edgeId, sanitizedTarget.aliasResourceId);
        targetIds.add(sanitizedTarget.aliasResourceId);
      } else {
        this.targetAliasByEdgeId.delete(record.edgeId);
      }
      lastSourceResourceId = record.sourceResourceId;
      records.push(record);
    }

    if (records.length > 0) {
      this.notifyEdgesChanged({
        targetResourceIds: [...targetIds],
        sourceResourceId: lastSourceResourceId,
      });
    }

    if (records.length > 0 && this.anchorEdgesAdapter) {
      try {
        await this.anchorEdgesAdapter.upsert(records);
      } catch (error) {
        this.onError?.(error);
      }
    }

    return { upserted: records.length, edges: records };
  }

  async pruneAnchorEdgesBySource(params: {
    sourceKind: AnchorEdgeSourceKind | string;
    sourceResourceId: string;
    keepEdgeIds?: readonly string[];
  }): Promise<{ deleted: number }> {
    const keepSet = new Set(params.keepEdgeIds ?? []);
    const targetIds = new Set<string>();
    let deleted = 0;

    for (const [edgeId, record] of [...this.edgesById.entries()]) {
      if (
        record.sourceKind === params.sourceKind &&
        record.sourceResourceId === params.sourceResourceId &&
        !keepSet.has(edgeId)
      ) {
        this.edgesById.delete(edgeId);
        const alias = this.targetAliasByEdgeId.get(edgeId);
        this.targetAliasByEdgeId.delete(edgeId);
        this.prunedEdgeIds.add(edgeId);
        targetIds.add(record.targetResourceId);
        if (alias) targetIds.add(alias);
        deleted += 1;
      }
    }

    if (deleted > 0) {
      this.notifyEdgesChanged({
        targetResourceIds: [...targetIds],
        sourceResourceId: params.sourceResourceId,
      });
    }

    if (this.anchorEdgesAdapter) {
      try {
        await this.anchorEdgesAdapter.deleteBySource({
          sourceKind: params.sourceKind,
          sourceResourceId: params.sourceResourceId,
          ...(params.keepEdgeIds ? { keepEdgeIds: [...params.keepEdgeIds] } : {}),
        });
        if (deleted === 0) {
          this.notifyEdgesChanged({
            targetResourceIds: [],
            sourceResourceId: params.sourceResourceId,
          });
        }
      } catch (error) {
        this.onError?.(error);
      }
    }

    return { deleted };
  }

  async queryAnchorEdgesByTarget(params: {
    targetResourceIds: readonly string[];
    targetKind?: SemanticAnchorKind | string;
  }): Promise<AnchorEdgeRecord[]> {
    const idSet = new Set(
      params.targetResourceIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    );
    if (idSet.size === 0) return [];

    if (this.anchorEdgesAdapter) {
      try {
        const persisted = await this.anchorEdgesAdapter.queryByTarget({
          targetResourceIds: [...idSet],
          ...(params.targetKind ? { targetKind: params.targetKind } : {}),
        });
        for (const rawRow of persisted) {
          const record = normalizePersistedAnchorEdgeRecord(rawRow);
          if (!record || this.prunedEdgeIds.has(record.edgeId)) continue;
          const existing = this.edgesById.get(record.edgeId);
          if (!existing || existing.updatedAt < record.updatedAt) {
            this.edgesById.set(record.edgeId, record);
            const parsedTarget = parseSemanticAnchor(record.targetAnchorUri);
            if (parsedTarget?.aliasResourceId) {
              this.targetAliasByEdgeId.set(record.edgeId, parsedTarget.aliasResourceId);
            }
          }
        }
      } catch (error) {
        this.onError?.(error);
      }
    }

    const matched: AnchorEdgeRecord[] = [];
    for (const [edgeId, record] of this.edgesById.entries()) {
      if (params.targetKind && record.targetKind !== params.targetKind) continue;
      const alias = this.targetAliasByEdgeId.get(edgeId);
      if (idSet.has(record.targetResourceId) || (alias && idSet.has(alias))) {
        matched.push(record);
      }
    }

    matched.sort((a, b) => a.createdAt - b.createdAt);
    return matched;
  }

  subscribeAnchorEdgesChanged(listener: (detail: AnchorEdgesChangedDetail) => void): UiDisposer {
    this.edgeListeners.add(listener);
    return () => {
      this.edgeListeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const bucket of this.handlersByKind.values()) {
      for (const entry of bucket.values()) {
        entry.active = false;
        entry.lifetime.abort();
      }
    }
    this.handlersByKind.clear();
    for (const waiter of [...this.pendingWaiters]) {
      waiter.cancel();
    }
    this.pendingWaiters.clear();
    this.edgeListeners.clear();
  }
}
