/**
 * Native Cordis `reviewSchedulers` registry (RFC-002 P2).
 *
 * Decouples spaced-repetition scheduling from hardcoded FSRS-6/7 flags so
 * Tier 3 plugins can register custom schedulers (e.g. SM-2, exam-cram sprint,
 * subject-specific intervals) while guaranteeing fail-safe fallback to `fsrs6`.
 */

export const DEFAULT_REVIEW_SCHEDULER_ID = 'fsrs6';

export interface SchedulerCardInput {
  cardId: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  reps: number;
  lapses: number;
  rating: 1 | 2 | 3 | 4;
}

export interface SchedulerNextState {
  intervalDays: number;
  stability: number;
  difficulty: number;
}

export interface ReviewSchedulerProvider {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly builtin?: boolean;
  /** Computes next interval / stability / difficulty for one review rating. */
  nextState(input: SchedulerCardInput): SchedulerNextState;
  /** Optional queue re-ranking hook (returns ordered cardIds). */
  orderQueue?(cardIds: readonly string[]): string[];
}

export interface ReviewSchedulerDescriptor {
  id: string;
  displayName: string;
  description: string;
  pluginId: string;
  builtin: boolean;
  active: boolean;
}

export interface ReviewSchedulerRegistryService {
  register(pluginId: string, provider: ReviewSchedulerProvider): () => void;
  list(): ReviewSchedulerDescriptor[];
  get(id: string): ReviewSchedulerProvider | null;
  getActiveId(): string;
  setActive(id: string): boolean;
  /** Safe compute helper: falls back to `fsrs6` if the active custom scheduler throws. */
  computeNextState(input: SchedulerCardInput): { schedulerId: string; state: SchedulerNextState; fellBack: boolean };
}

interface Entry {
  pluginId: string;
  provider: ReviewSchedulerProvider;
}

function defaultFsrs6Fallback(input: SchedulerCardInput): SchedulerNextState {
  // Deterministic lightweight fallback math used when invoking registry directly;
  // full native FSRS-6 engine continues to run inside FsrsReviewService.
  const baseStability = Math.max(0.5, input.stability || 1);
  const multiplier = input.rating === 1 ? 0.25 : input.rating === 2 ? 1.2 : input.rating === 3 ? 2.2 : 3.2;
  const nextStability = Math.max(0.25, Number((baseStability * multiplier).toFixed(2)));
  const intervalDays = input.rating === 1 ? 0 : Math.max(1, Math.round(nextStability));
  const difficulty = Math.max(1, Math.min(10, (input.difficulty || 5) + (input.rating === 1 ? 0.8 : input.rating === 4 ? -0.5 : 0)));
  return { intervalDays, stability: nextStability, difficulty };
}

export class ReviewSchedulerRegistry implements ReviewSchedulerRegistryService {
  private readonly entries = new Map<string, Entry>();
  private activeId: string = DEFAULT_REVIEW_SCHEDULER_ID;
  private readonly warn: (message: string) => void;

  constructor(warn: (message: string) => void = () => undefined) {
    this.warn = warn;
    this.entries.set(DEFAULT_REVIEW_SCHEDULER_ID, {
      pluginId: 'dstu.review',
      provider: {
        id: DEFAULT_REVIEW_SCHEDULER_ID,
        displayName: 'FSRS-6 (Default)',
        description: 'Built-in DeepStudent FSRS-6 spaced repetition scheduler',
        builtin: true,
        nextState: defaultFsrs6Fallback,
      },
    });
  }

  register(pluginId: string, provider: ReviewSchedulerProvider): () => void {
    const cleanPluginId = pluginId.trim();
    const cleanId = provider.id.trim();
    if (!cleanPluginId || !cleanId) {
      throw new Error('reviewSchedulers.register requires non-empty pluginId and provider.id');
    }
    if (cleanId === DEFAULT_REVIEW_SCHEDULER_ID && cleanPluginId !== 'dstu.review') {
      throw new Error(`reviewSchedulers.register: cannot overwrite built-in "${DEFAULT_REVIEW_SCHEDULER_ID}"`);
    }
    this.entries.set(cleanId, { pluginId: cleanPluginId, provider: { ...provider, id: cleanId } });

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.entries.get(cleanId);
      if (current && current.pluginId === cleanPluginId) {
        this.entries.delete(cleanId);
        if (this.activeId === cleanId) {
          this.activeId = DEFAULT_REVIEW_SCHEDULER_ID;
        }
      }
    };
  }

  list(): ReviewSchedulerDescriptor[] {
    return [...this.entries.values()].map(({ pluginId, provider }) => ({
      id: provider.id,
      displayName: provider.displayName,
      description: provider.description,
      pluginId,
      builtin: provider.builtin === true,
      active: provider.id === this.activeId,
    }));
  }

  get(id: string): ReviewSchedulerProvider | null {
    return this.entries.get(id.trim())?.provider ?? null;
  }

  getActiveId(): string {
    return this.entries.has(this.activeId) ? this.activeId : DEFAULT_REVIEW_SCHEDULER_ID;
  }

  setActive(id: string): boolean {
    const cleanId = id.trim();
    if (!this.entries.has(cleanId)) return false;
    this.activeId = cleanId;
    return true;
  }

  computeNextState(input: SchedulerCardInput): { schedulerId: string; state: SchedulerNextState; fellBack: boolean } {
    const active = this.entries.get(this.activeId)?.provider;
    if (active && active.id !== DEFAULT_REVIEW_SCHEDULER_ID) {
      try {
        const state = active.nextState(input);
        if (Number.isFinite(state.intervalDays) && Number.isFinite(state.stability) && Number.isFinite(state.difficulty)) {
          return { schedulerId: active.id, state, fellBack: false };
        }
        throw new Error('scheduler returned non-finite numeric values');
      } catch (error) {
        this.warn(`[reviewSchedulers] "${active.id}" failed, falling back to ${DEFAULT_REVIEW_SCHEDULER_ID}: ${error instanceof Error ? error.message : String(error)}`);
        const fallback = this.entries.get(DEFAULT_REVIEW_SCHEDULER_ID)!.provider;
        return { schedulerId: DEFAULT_REVIEW_SCHEDULER_ID, state: fallback.nextState(input), fellBack: true };
      }
    }
    const fallback = this.entries.get(DEFAULT_REVIEW_SCHEDULER_ID)!.provider;
    return { schedulerId: DEFAULT_REVIEW_SCHEDULER_ID, state: fallback.nextState(input), fellBack: false };
  }
}
