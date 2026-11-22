/**
 * Top banner priority arbitrator for NotesCrepeEditor.
 *
 * Prevents 4+ banners from stacking simultaneously above the editor canvas by
 * selecting a single highest-priority `primary` banner, preserving an active
 * `ai-diff` review surface in `secondary` when a higher-priority banner (such as
 * `conflict`) interrupts it, and queuing the remaining active banners behind a
 * compact "+N" summary pill.
 */

export const BANNER_PRIORITY_ORDER = [
  'conflict',
  'host-refresh-error',
  'draft-persistence-error',
  'recovery-draft',
  'recovered-drafts',
  'ai-recovery',
  'ai-diff',
  'ai-collapsed',
  'agent-write',
  'ai-checkpoint',
  'review-due',
] as const;

export type BannerId = (typeof BANNER_PRIORITY_ORDER)[number];

/**
 * Banners that remain co-visible in `secondary` when preempted by a higher-priority
 * banner (e.g. an active AI diff review should not abruptly vanish if a sync conflict
 * or host error appears above it).
 */
const CO_VISIBLE_BANNERS: ReadonlySet<BannerId> = new Set<BannerId>(['ai-diff']);

const PRIORITY_INDEX: ReadonlyMap<BannerId, number> = new Map(
  BANNER_PRIORITY_ORDER.map((id, index) => [id, index]),
);

export interface BannerSlots {
  /** Highest-priority active banner rendered in full. */
  primary: BannerId | null;
  /** Co-visible banner(s) kept visible alongside `primary` (e.g. active `ai-diff`). */
  secondary: BannerId[];
  /** Remaining active banners in priority order, collapsed behind a "+N" pill by default. */
  queued: BannerId[];
  /** Count of collapsed banners currently hidden in `queued`. */
  hiddenCount: number;
}

export interface ResolveBannerSlotsOptions {
  /**
   * Whether an active `ai-diff` banner stays visible in `secondary` alongside a
   * higher-priority `primary` banner. Defaults to `true`.
   */
  allowCoVisibleAiDiff?: boolean;
  /**
   * Optional explicit set of banners permitted to stay co-visible in `secondary`
   * alongside `primary` (e.g. an active `ai-diff` or immediate `agent-write` undo bar).
   * When omitted, falls back to `['ai-diff']` if `allowCoVisibleAiDiff` is true.
   */
  coVisibleBanners?: readonly BannerId[];
}

/** Returns 0-based priority rank (0 = highest priority). */
export function getBannerPriority(id: BannerId): number {
  return PRIORITY_INDEX.get(id) ?? BANNER_PRIORITY_ORDER.length;
}

/** Deduplicates and sorts active banner IDs from highest to lowest priority. */
export function sortBannersByPriority(activeBanners: readonly BannerId[]): BannerId[] {
  const seen = new Set<BannerId>();
  const valid: BannerId[] = [];
  for (const id of activeBanners) {
    if (PRIORITY_INDEX.has(id) && !seen.has(id)) {
      seen.add(id);
      valid.push(id);
    }
  }
  valid.sort((a, b) => getBannerPriority(a) - getBannerPriority(b));
  return valid;
}

/**
 * Arbitrates active editor banners into `primary`, `secondary`, and `queued` slots.
 */
export function resolveBannerSlots(
  activeBanners: readonly BannerId[],
  options?: ResolveBannerSlotsOptions,
): BannerSlots {
  const sorted = sortBannersByPriority(activeBanners);
  if (sorted.length === 0) {
    return {
      primary: null,
      secondary: [],
      queued: [],
      hiddenCount: 0,
    };
  }

  const coVisibleSet: ReadonlySet<BannerId> | null = options?.coVisibleBanners
    ? new Set<BannerId>(options.coVisibleBanners)
    : (options?.allowCoVisibleAiDiff ?? true)
      ? CO_VISIBLE_BANNERS
      : null;
  const [primary, ...rest] = sorted;
  const secondary: BannerId[] = [];
  const queued: BannerId[] = [];

  for (const id of rest) {
    if (coVisibleSet?.has(id)) {
      secondary.push(id);
    } else {
      queued.push(id);
    }
  }

  return {
    primary,
    secondary,
    queued,
    hiddenCount: queued.length,
  };
}

/**
 * Convenience predicate for NotesCrepeEditor to check whether a given banner should
 * currently render. When `expanded` is true (user clicked "+N"), queued banners are
 * also revealed.
 */
export function isBannerVisible(
  slots: BannerSlots,
  id: BannerId,
  expanded = false,
): boolean {
  if (slots.primary === id) return true;
  if (slots.secondary.includes(id)) return true;
  if (expanded && slots.queued.includes(id)) return true;
  return false;
}
