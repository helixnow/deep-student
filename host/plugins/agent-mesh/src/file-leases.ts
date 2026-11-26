/**
 * Path-Granularity `FileLeaseTable` for Concurrent Same-Directory Safety.
 *
 * Enables multiple coding agents (e.g. `@claude` + `@codex`) to work in-place
 * inside the same workspace directory without colliding on overlapping files:
 * - Disjoint file paths or directory globs acquire immediately in parallel;
 * - Re-entrant acquisitions by the same `holderAgentId` succeed and refresh TTL;
 * - Overlapping paths held by another active agent wait on an internal event
 *   queue up to `waitMs` and wake immediately upon release or TTL expiry;
 * - If still held after `waitMs`, returns structured conflict metadata so the
 *   caller can steer the agent to coordinate with its peer.
 */
import * as fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_FILE_LEASE_TTL_MS = 120_000;
export const MAX_FILE_LEASE_WAIT_MS = 60_000;

export interface ActiveFileLease {
  leaseId: string;
  canonicalRoot: string;
  pattern: string;
  holderAgentId: string;
  threadId: string;
  heldSince: number;
  expiresAt: number;
}

export interface FileLeaseConflict {
  holderAgentId: string;
  holderThreadId: string;
  conflictingPattern: string;
  requestedPattern: string;
  heldSince: number;
  expiresAt: number;
}

export interface AcquireLeaseInput {
  rootPath: string;
  patterns: string[];
  holderAgentId: string;
  threadId?: string;
  ttlMs?: number;
  waitMs?: number;
  signal?: AbortSignal;
}

export type AcquireLeaseResult =
  | {
      granted: true;
      leases: ActiveFileLease[];
      waitedMs: number;
    }
  | {
      granted: false;
      conflict: FileLeaseConflict;
      hint: string;
      waitedMs: number;
    };

interface WaiterEntry {
  canonicalRoot: string;
  normalizedPatterns: string[];
  holderAgentId: string;
  threadId: string;
  ttlMs: number;
  enqueuedAt: number;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  abortCleanup: (() => void) | null;
  settled: boolean;
  resolve: (result: AcquireLeaseResult) => void;
}

type SegmentToken =
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'lit'; ch: string }
  | { kind: 'class'; chars: ReadonlySet<string>; negated: boolean };

let leaseSeq = 0;

function ignorePathResolutionError(_error: unknown): void {
  /* Non-existent paths fall back cleanly to lexical relative normalization. */
}

export function resolveLeaseCanonicalRoot(rootPath: string): string {
  const trimmed = rootPath.trim();
  if (!trimmed) {
    throw new Error('rootPath is required for FileLeaseTable');
  }
  try {
    return fs.realpathSync.native(trimmed).replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  } catch {
    return path.resolve(trimmed).replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  }
}

export function normalizeLeasePattern(rawPattern: string, canonicalRoot: string): string {
  const raw = rawPattern.trim().replaceAll('\\', '/');
  if (!raw || raw === '.' || raw === './' || raw === '**/*') {
    return '**';
  }

  let candidate = raw;
  const rootWithSlash = canonicalRoot === '/' ? '/' : `${canonicalRoot}/`;
  if (candidate === canonicalRoot) {
    return '**';
  }
  if (candidate.startsWith(rootWithSlash)) {
    candidate = candidate.slice(rootWithSlash.length);
  } else if (path.isAbsolute(rawPattern)) {
    try {
      const parentReal = fs.realpathSync.native(path.dirname(rawPattern)).replaceAll('\\', '/');
      const fullCandidate = `${parentReal}/${path.basename(rawPattern)}`;
      if (fullCandidate === canonicalRoot) return '**';
      if (fullCandidate.startsWith(rootWithSlash)) {
        candidate = fullCandidate.slice(rootWithSlash.length);
      }
    } catch (err) {
      ignorePathResolutionError(err);
    }
  }

  const hadTrailingSlash = candidate.endsWith('/');
  candidate = candidate.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!candidate || candidate === '.') {
    return '**';
  }

  const rawSegments = candidate.split('/');
  const cleanSegments: string[] = [];
  for (const seg of rawSegments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      throw new Error(`Lease pattern cannot escape workspace root: ${rawPattern}`);
    }
    // Collapse consecutive `**` segments (`a/**/**/b` === `a/**/b`)
    if (seg === '**' && cleanSegments.at(-1) === '**') continue;
    cleanSegments.push(seg);
  }

  if (cleanSegments.length === 0) {
    return '**';
  }
  if (hadTrailingSlash && cleanSegments.at(-1) !== '**') {
    cleanSegments.push('**');
  }
  if (cleanSegments.length === 2 && cleanSegments[0] === '**' && cleanSegments[1] === '*') {
    return '**';
  }
  return cleanSegments.join('/');
}

function expandBraces(segment: string): string[] {
  const openIdx = segment.indexOf('{');
  if (openIdx < 0) return [segment];
  const closeIdx = segment.indexOf('}', openIdx + 1);
  if (closeIdx < 0) return [segment];
  const prefix = segment.slice(0, openIdx);
  const suffix = segment.slice(closeIdx + 1);
  const options = segment.slice(openIdx + 1, closeIdx).split(',');
  const results: string[] = [];
  for (const opt of options) {
    for (const expanded of expandBraces(`${prefix}${opt}${suffix}`)) {
      results.push(expanded);
    }
  }
  return results;
}

function tokenizeSingleSegment(pattern: string): SegmentToken[] {
  const tokens: SegmentToken[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (tokens.at(-1)?.kind !== 'star') {
        tokens.push({ kind: 'star' });
      }
      i++;
    } else if (ch === '?') {
      tokens.push({ kind: 'any' });
      i++;
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) {
        tokens.push({ kind: 'lit', ch });
        i++;
      } else {
        let body = pattern.slice(i + 1, close);
        let negated = false;
        if (body.startsWith('!') || body.startsWith('^')) {
          negated = true;
          body = body.slice(1);
        }
        const chars = new Set<string>();
        for (let k = 0; k < body.length; k++) {
          if (k + 2 < body.length && body[k + 1] === '-') {
            const startCode = body.charCodeAt(k);
            const endCode = body.charCodeAt(k + 2);
            const lo = Math.min(startCode, endCode);
            const hi = Math.max(startCode, endCode);
            for (let code = lo; code <= hi && code - lo <= 256; code++) {
              chars.add(String.fromCharCode(code));
            }
            k += 2;
          } else {
            chars.add(body[k]!);
          }
        }
        tokens.push({ kind: 'class', chars, negated });
        i = close + 1;
      }
    } else if (ch === '\\' && i + 1 < pattern.length) {
      tokens.push({ kind: 'lit', ch: pattern[i + 1]! });
      i += 2;
    } else {
      tokens.push({ kind: 'lit', ch });
      i++;
    }
  }
  return tokens;
}

function singleCharTokensOverlap(a: Exclude<SegmentToken, { kind: 'star' }>, b: Exclude<SegmentToken, { kind: 'star' }>): boolean {
  if (a.kind === 'any' || b.kind === 'any') return true;
  if (a.kind === 'lit' && b.kind === 'lit') return a.ch === b.ch;
  if (a.kind === 'lit' && b.kind === 'class') {
    const has = b.chars.has(a.ch);
    return b.negated ? !has : has;
  }
  if (a.kind === 'class' && b.kind === 'lit') {
    const has = a.chars.has(b.ch);
    return a.negated ? !has : has;
  }
  if (a.kind === 'class' && b.kind === 'class') {
    if (!a.negated && !b.negated) {
      for (const ch of a.chars) {
        if (b.chars.has(ch)) return true;
      }
      return false;
    }
    if (!a.negated && b.negated) {
      for (const ch of a.chars) {
        if (!b.chars.has(ch)) return true;
      }
      return false;
    }
    if (a.negated && !b.negated) {
      for (const ch of b.chars) {
        if (!a.chars.has(ch)) return true;
      }
      return false;
    }
    // Both negated character sets over Unicode are infinite so they always share a non-`/` char.
    return true;
  }
  return false;
}

function tokenStreamsIntersect(a: SegmentToken[], b: SegmentToken[]): boolean {
  const m = a.length;
  const n = b.length;
  const width = n + 1;
  const memo = new Int8Array((m + 1) * width);

  const visit = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo[key];
    if (cached !== 0) return cached === 1;

    let ok = false;
    if (i === m && j === n) {
      ok = true;
    } else if (i < m && a[i]!.kind === 'star') {
      ok = visit(i + 1, j) || (j < n && visit(i, j + 1));
    } else if (j < n && b[j]!.kind === 'star') {
      ok = visit(i, j + 1) || (i < m && visit(i + 1, j));
    } else if (i < m && j < n) {
      const ta = a[i] as Exclude<SegmentToken, { kind: 'star' }>;
      const tb = b[j] as Exclude<SegmentToken, { kind: 'star' }>;
      ok = singleCharTokensOverlap(ta, tb) && visit(i + 1, j + 1);
    }

    memo[key] = ok ? 1 : -1;
    return ok;
  };

  return visit(0, 0);
}

function singleSegmentsIntersect(segA: string, segB: string): boolean {
  if (segA === segB) return true;
  if (segA === '*' || segB === '*') return true;
  const altsA = expandBraces(segA);
  const altsB = expandBraces(segB);
  for (const a of altsA) {
    const tokA = tokenizeSingleSegment(a);
    for (const b of altsB) {
      const tokB = tokenizeSingleSegment(b);
      if (tokenStreamsIntersect(tokA, tokB)) return true;
    }
  }
  return false;
}

function hasGlobSyntax(segment: string): boolean {
  return /[*?[\]{}]/.test(segment);
}

/**
 * Determines whether two normalized relative lease patterns (`src/raft/**`, `src/raft/node.ts`,
 * `src/**\/*.test.ts`, `src/raft`) can refer to the same file or ancestor/descendant directory tree.
 */
export function patternsOverlap(normalizedA: string, normalizedB: string): boolean {
  if (normalizedA === normalizedB) return true;
  if (normalizedA === '**' || normalizedB === '**') return true;

  const segsA = normalizedA.split('/');
  const segsB = normalizedB.split('/');

  // Direct directory-prefix relationship when an agent claims a directory name without trailing `/**`
  // (e.g. `src/raft` vs `src/raft/node.ts`). In POSIX filesystems a file and a directory cannot share
  // the same path anyway, and claiming `src/raft` covers descendants under `src/raft/`.
  const minLen = Math.min(segsA.length, segsB.length);
  const shorter = segsA.length <= segsB.length ? segsA : segsB;
  if (segsA.length !== segsB.length && shorter.every((s) => !hasGlobSyntax(s))) {
    let allPrefixMatch = true;
    for (let k = 0; k < minLen; k++) {
      if (segsA[k] === '**' || segsB[k] === '**') break;
      if (!singleSegmentsIntersect(segsA[k]!, segsB[k]!)) {
        allPrefixMatch = false;
        break;
      }
    }
    if (allPrefixMatch) return true;
  }

  const m = segsA.length;
  const n = segsB.length;
  const width = n + 1;
  const memo = new Int8Array((m + 1) * width);

  const visit = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo[key];
    if (cached !== 0) return cached === 1;

    let ok = false;
    if (i === m && j === n) {
      ok = true;
    } else if (i < m && segsA[i] === '**') {
      // `**` matches 0 segments OR >=1 segments
      ok = visit(i + 1, j) || (j < n && visit(i, j + 1));
    } else if (j < n && segsB[j] === '**') {
      ok = visit(i, j + 1) || (i < m && visit(i + 1, j));
    } else if (i < m && j < n) {
      ok = singleSegmentsIntersect(segsA[i]!, segsB[j]!) && visit(i + 1, j + 1);
    }

    memo[key] = ok ? 1 : -1;
    return ok;
  };

  return visit(0, 0);
}

export class FileLeaseTable {
  readonly #defaultTtlMs: number;
  readonly #nowFn: () => number;
  readonly #leases = new Map<string, ActiveFileLease>();
  readonly #waiters: WaiterEntry[] = [];
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: { defaultTtlMs?: number; now?: () => number }) {
    this.#defaultTtlMs = options?.defaultTtlMs ?? DEFAULT_FILE_LEASE_TTL_MS;
    this.#nowFn = options?.now ?? (() => Date.now());
  }

  #pruneExpired(now = this.#nowFn()): boolean {
    let removedAny = false;
    for (const [id, lease] of this.#leases.entries()) {
      if (lease.expiresAt <= now) {
        this.#leases.delete(id);
        removedAny = true;
      }
    }
    this.#scheduleNextExpiryTimer(now);
    return removedAny;
  }

  #scheduleNextExpiryTimer(now = this.#nowFn()): void {
    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const lease of this.#leases.values()) {
      if (lease.expiresAt < earliest) {
        earliest = lease.expiresAt;
      }
    }
    if (!Number.isFinite(earliest)) return;
    const delayMs = Math.max(1, earliest - now);
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = null;
      const expired = this.#pruneExpired();
      if (expired) {
        this.#drainWaiters();
      }
    }, delayMs);
    this.#expiryTimer.unref?.();
  }

  #findConflict(
    canonicalRoot: string,
    normalizedPatterns: readonly string[],
    holderAgentId: string,
  ): FileLeaseConflict | null {
    for (const requestedPattern of normalizedPatterns) {
      for (const existing of this.#leases.values()) {
        if (existing.canonicalRoot !== canonicalRoot) continue;
        if (existing.holderAgentId === holderAgentId) continue;
        if (patternsOverlap(requestedPattern, existing.pattern)) {
          return {
            holderAgentId: existing.holderAgentId,
            holderThreadId: existing.threadId,
            conflictingPattern: existing.pattern,
            requestedPattern,
            heldSince: existing.heldSince,
            expiresAt: existing.expiresAt,
          };
        }
      }
    }
    return null;
  }

  #grantImmediately(
    canonicalRoot: string,
    normalizedPatterns: readonly string[],
    holderAgentId: string,
    threadId: string,
    ttlMs: number,
    now: number,
  ): ActiveFileLease[] {
    const granted: ActiveFileLease[] = [];
    const expiresAt = now + ttlMs;

    for (const pattern of normalizedPatterns) {
      let existingMatch: ActiveFileLease | undefined;
      for (const lease of this.#leases.values()) {
        if (
          lease.canonicalRoot === canonicalRoot &&
          lease.holderAgentId === holderAgentId &&
          lease.pattern === pattern
        ) {
          existingMatch = lease;
          break;
        }
      }

      if (existingMatch) {
        const refreshed: ActiveFileLease = {
          ...existingMatch,
          threadId: threadId || existingMatch.threadId,
          expiresAt: Math.max(existingMatch.expiresAt, expiresAt),
        };
        this.#leases.set(refreshed.leaseId, refreshed);
        granted.push({ ...refreshed });
      } else {
        const created: ActiveFileLease = {
          leaseId: `lease-${++leaseSeq}`,
          canonicalRoot,
          pattern,
          holderAgentId,
          threadId,
          heldSince: now,
          expiresAt,
        };
        this.#leases.set(created.leaseId, created);
        granted.push({ ...created });
      }
    }

    // Also refresh any pre-existing overlapping leases owned by the same `holderAgentId`
    for (const [id, lease] of this.#leases.entries()) {
      if (lease.canonicalRoot !== canonicalRoot || lease.holderAgentId !== holderAgentId) continue;
      if (normalizedPatterns.some((p) => p !== lease.pattern && patternsOverlap(p, lease.pattern))) {
        this.#leases.set(id, {
          ...lease,
          expiresAt: Math.max(lease.expiresAt, expiresAt),
        });
      }
    }

    this.#scheduleNextExpiryTimer(now);
    return granted;
  }

  #removeWaiter(waiter: WaiterEntry): void {
    const idx = this.#waiters.indexOf(waiter);
    if (idx >= 0) {
      this.#waiters.splice(idx, 1);
    }
    if (waiter.deadlineTimer !== null) {
      clearTimeout(waiter.deadlineTimer);
      waiter.deadlineTimer = null;
    }
    if (waiter.abortCleanup !== null) {
      waiter.abortCleanup();
      waiter.abortCleanup = null;
    }
  }

  #drainWaiters(): void {
    const now = this.#nowFn();
    this.#pruneExpired(now);
    // Iterate snapshot in FIFO order; disjoint queued waiters can all wake in the same pass!
    for (const waiter of [...this.#waiters]) {
      if (waiter.settled) continue;
      const conflict = this.#findConflict(
        waiter.canonicalRoot,
        waiter.normalizedPatterns,
        waiter.holderAgentId,
      );
      if (!conflict) {
        waiter.settled = true;
        this.#removeWaiter(waiter);
        const leases = this.#grantImmediately(
          waiter.canonicalRoot,
          waiter.normalizedPatterns,
          waiter.holderAgentId,
          waiter.threadId,
          waiter.ttlMs,
          now,
        );
        waiter.resolve({
          granted: true,
          leases,
          waitedMs: Math.max(0, now - waiter.enqueuedAt),
        });
      }
    }
  }

  #formatConflictHint(conflict: FileLeaseConflict): string {
    return (
      `Path "${conflict.requestedPattern}" conflicts with active lease "${conflict.conflictingPattern}" ` +
      `held by @${conflict.holderAgentId}. Handle non-overlapping files first or coordinate with ` +
      `@${conflict.holderAgentId} on the mesh board.`
    );
  }

  async acquireLease(input: AcquireLeaseInput): Promise<AcquireLeaseResult> {
    const holderAgentId = input.holderAgentId.trim();
    if (!holderAgentId) {
      throw new Error('holderAgentId is required to acquire a file lease');
    }
    if (!Array.isArray(input.patterns) || input.patterns.length === 0) {
      throw new Error('At least one path or glob pattern is required to acquire a file lease');
    }

    const canonicalRoot = resolveLeaseCanonicalRoot(input.rootPath);
    const dedupedPatterns: string[] = [];
    const seen = new Set<string>();
    for (const raw of input.patterns) {
      const norm = normalizeLeasePattern(raw, canonicalRoot);
      if (!seen.has(norm)) {
        seen.add(norm);
        dedupedPatterns.push(norm);
      }
    }

    const ttlMs = input.ttlMs !== undefined && input.ttlMs > 0 ? input.ttlMs : this.#defaultTtlMs;
    const waitMs = Math.min(
      MAX_FILE_LEASE_WAIT_MS,
      Math.max(0, input.waitMs ?? 0),
    );
    const threadId = input.threadId ?? '';

    const startedAt = this.#nowFn();
    this.#pruneExpired(startedAt);

    const immediateConflict = this.#findConflict(canonicalRoot, dedupedPatterns, holderAgentId);
    if (!immediateConflict) {
      const leases = this.#grantImmediately(
        canonicalRoot,
        dedupedPatterns,
        holderAgentId,
        threadId,
        ttlMs,
        startedAt,
      );
      return { granted: true, leases, waitedMs: 0 };
    }

    if (waitMs <= 0 || input.signal?.aborted) {
      return {
        granted: false,
        conflict: immediateConflict,
        hint: this.#formatConflictHint(immediateConflict),
        waitedMs: 0,
      };
    }

    return new Promise<AcquireLeaseResult>((resolve) => {
      const waiter: WaiterEntry = {
        canonicalRoot,
        normalizedPatterns: dedupedPatterns,
        holderAgentId,
        threadId,
        ttlMs,
        enqueuedAt: startedAt,
        deadlineTimer: null,
        abortCleanup: null,
        settled: false,
        resolve,
      };

      const settleOnTimeoutOrAbort = (): void => {
        if (waiter.settled) return;
        const now = this.#nowFn();
        this.#pruneExpired(now);
        const stillConflict = this.#findConflict(
          waiter.canonicalRoot,
          waiter.normalizedPatterns,
          waiter.holderAgentId,
        );
        waiter.settled = true;
        this.#removeWaiter(waiter);

        if (!stillConflict && !input.signal?.aborted) {
          const leases = this.#grantImmediately(
            waiter.canonicalRoot,
            waiter.normalizedPatterns,
            waiter.holderAgentId,
            waiter.threadId,
            waiter.ttlMs,
            now,
          );
          resolve({
            granted: true,
            leases,
            waitedMs: Math.max(0, now - startedAt),
          });
          return;
        }

        const effectiveConflict = stillConflict ?? immediateConflict;
        resolve({
          granted: false,
          conflict: effectiveConflict,
          hint: this.#formatConflictHint(effectiveConflict),
          waitedMs: Math.max(0, now - startedAt),
        });
      };

      waiter.deadlineTimer = setTimeout(settleOnTimeoutOrAbort, waitMs);
      waiter.deadlineTimer.unref?.();

      if (input.signal) {
        const onAbort = (): void => settleOnTimeoutOrAbort();
        input.signal.addEventListener('abort', onAbort, { once: true });
        waiter.abortCleanup = () => input.signal?.removeEventListener('abort', onAbort);
      }

      this.#waiters.push(waiter);
    });
  }

  /**
   * Releases leases held by `holderAgentId` (optionally scoped to `threadId`, `rootPath`, and/or specific `patterns`),
   * immediately waking any queued waiters whose paths become free.
   */
  releaseAgentLeases(
    holderAgentId: string,
    threadId?: string,
    options?: { rootPath?: string; patterns?: string[] },
  ): number {
    this.#pruneExpired();
    const targetRoot = options?.rootPath ? resolveLeaseCanonicalRoot(options.rootPath) : undefined;
    const normalizedFilter = options?.patterns && options.patterns.length > 0 && targetRoot
      ? options.patterns.map((p) => normalizeLeasePattern(p, targetRoot))
      : options?.patterns && options.patterns.length > 0
        ? options.patterns
        : null;

    let released = 0;
    for (const [id, lease] of this.#leases.entries()) {
      if (lease.holderAgentId !== holderAgentId) continue;
      if (threadId !== undefined && lease.threadId !== threadId) continue;
      if (targetRoot !== undefined && lease.canonicalRoot !== targetRoot) continue;
      if (normalizedFilter !== null) {
        const normAgainstLeaseRoot = normalizedFilter.map((p) =>
          targetRoot ? p : normalizeLeasePattern(p, lease.canonicalRoot),
        );
        const matches = normAgainstLeaseRoot.some(
          (filterPat) => filterPat === lease.pattern || patternsOverlap(filterPat, lease.pattern),
        );
        if (!matches) continue;
      }
      this.#leases.delete(id);
      released++;
    }

    if (released > 0) {
      this.#scheduleNextExpiryTimer();
      this.#drainWaiters();
    }
    return released;
  }

  listActiveLeases(rootPath?: string): ActiveFileLease[] {
    this.#pruneExpired();
    const targetRoot = rootPath ? resolveLeaseCanonicalRoot(rootPath) : undefined;
    const result: ActiveFileLease[] = [];
    for (const lease of this.#leases.values()) {
      if (targetRoot !== undefined && lease.canonicalRoot !== targetRoot) continue;
      result.push({ ...lease });
    }
    result.sort((a, b) => a.heldSince - b.heldSince || a.leaseId.localeCompare(b.leaseId));
    return result;
  }

  /**
   * Non-blocking conflict probe for pre-tool inspection (`canUseTool` / UI lock badges).
   */
  inspectConflict(rootPath: string, targetPathOrPattern: string, requesterAgentId: string): FileLeaseConflict | null {
    this.#pruneExpired();
    const canonicalRoot = resolveLeaseCanonicalRoot(rootPath);
    const norm = normalizeLeasePattern(targetPathOrPattern, canonicalRoot);
    return this.#findConflict(canonicalRoot, [norm], requesterAgentId);
  }

  dispose(): void {
    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
    const now = this.#nowFn();
    for (const waiter of [...this.#waiters]) {
      if (waiter.settled) continue;
      waiter.settled = true;
      this.#removeWaiter(waiter);
      const fallbackConflict: FileLeaseConflict = {
        holderAgentId: 'disposed',
        holderThreadId: '',
        conflictingPattern: waiter.normalizedPatterns[0] ?? '**',
        requestedPattern: waiter.normalizedPatterns[0] ?? '**',
        heldSince: waiter.enqueuedAt,
        expiresAt: now,
      };
      waiter.resolve({
        granted: false,
        conflict: fallbackConflict,
        hint: 'FileLeaseTable was disposed before lease could be granted.',
        waitedMs: Math.max(0, now - waiter.enqueuedAt),
      });
    }
    this.#leases.clear();
  }
}
