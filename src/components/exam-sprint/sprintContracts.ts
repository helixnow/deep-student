import type {
  BuildDailySprintRequest,
  ClientMindmapReciteSignal,
  ConceptMasteryDelta,
  DailySprintPlan,
  ExamHorizonConfig,
  ExamHorizonConfigPatch,
  ExamPhase,
  ExamReadinessSnapshot,
  GenerateMistakeVariantRequest,
  GenerateMistakeVariantResult,
  SettleSprintSessionRequest,
  SprintCompletedItemRecord,
  SprintFsrsCardItem,
  SprintItemTriageMeta,
  SprintMindmapBlankRange,
  SprintMindmapClozeItem,
  SprintMistakeItem,
  SprintMistakeQuestionOption,
  SprintQueueItem,
  SprintSessionSettlement,
  SprintSourceAnchor,
} from '@/shared/exam-sprint';
import type {
  ExcerptContentKind,
  SemanticAnchor,
  SemanticAnchorKind,
} from '@/ui-kernel/contracts/interop';

export type {
  BuildDailySprintRequest,
  ClientMindmapReciteSignal,
  ConceptMasteryDelta,
  DailySprintPlan,
  ExamHorizonConfig,
  ExamHorizonConfigPatch,
  ExamPhase,
  ExamReadinessSnapshot,
  ExcerptContentKind,
  GenerateMistakeVariantRequest,
  GenerateMistakeVariantResult,
  SemanticAnchor,
  SemanticAnchorKind,
  SettleSprintSessionRequest,
  SprintCompletedItemRecord,
  SprintFsrsCardItem,
  SprintItemTriageMeta,
  SprintMindmapBlankRange,
  SprintMindmapClozeItem,
  SprintMistakeItem,
  SprintMistakeQuestionOption,
  SprintQueueItem,
  SprintSessionSettlement,
  SprintSourceAnchor,
};

export type SprintRating = 1 | 2 | 3 | 4;

export type SprintAnchorInput = SemanticAnchor | SprintSourceAnchor | string;

export interface ResolvedSprintSourceAnchor {
  canonicalUri: string;
  semanticAnchor: SemanticAnchor | null;
  kind: SemanticAnchorKind;
  resourceId: string;
  label: string | null;
  page: number | null;
  startMs: number | null;
  endMs: number | null;
  blockId: string | null;
  nodeId: string | null;
  questionId: string | null;
  quote: string | null;
}

export interface SprintCompoundExcerpt {
  id?: string;
  kind?: 'quote' | 'image' | 'transcript' | 'mistake' | 'note';
  excerptKind?: ExcerptContentKind;
  text?: string | null;
  quote?: string | null;
  extractedText?: string | null;
  latex?: string | null;
  imageDataUrl?: string | null;
  imageAsset?: string | null;
  imageUrl?: string | null;
  sourceTitle?: string | null;
  sourceLabel?: string | null;
  anchor?: SprintAnchorInput | null;
  anchorUri?: string | null;
}

export interface SprintCompoundExtensions {
  /** Multi-source semantic anchors (C7 §2.5 & §3.4: e.g. MindMap node + PDF p.42 + PDF p.108) */
  sourceAnchors?: readonly SprintAnchorInput[] | null;
  /** Ancestor path metadata above the card face (e.g. ['Chapter 3', 'Limits']) */
  ancestorPath?: readonly string[] | null;
  /** Origin plugin kind when projected via Live Card Projection API */
  projectedSourceKind?: SemanticAnchorKind | null;
  /** Multi-source evidence excerpts rendered on revealed back face */
  excerpts?: readonly SprintCompoundExcerpt[] | null;
  /** Child node key-point summary bullets rendered on revealed back face */
  childSummaries?: readonly string[] | null;
  /** Personal understanding annotation rendered on revealed back face */
  personalNote?: string | null;
}

export type SprintCompoundFsrsCardItem = SprintFsrsCardItem & SprintCompoundExtensions;

export type SprintCompoundMistakeItem = SprintMistakeItem & SprintCompoundExtensions;

export type SprintCompoundMindmapClozeItem = SprintMindmapClozeItem &
  Omit<SprintCompoundExtensions, 'ancestorPath'>;

export type SprintCompoundQueueItem =
  | SprintCompoundFsrsCardItem
  | SprintCompoundMistakeItem
  | SprintCompoundMindmapClozeItem;

export interface SprintCompoundPlan extends Omit<DailySprintPlan, 'items'> {
  items: SprintCompoundQueueItem[];
}

export type DailySprintLaunchSource =
  | 'study-space-header'
  | 'desktop-agenda'
  | 'mobile-banner'
  | 'today-hint'
  | 'extra-batch'
  | 'programmatic';

export interface OpenDailySprintOptions {
  source?: DailySprintLaunchSource;
  spaceId?: string | null;
  rootFolderId?: string | null;
  examDateOverride?: string | null;
  sprintBudgetMinutesOverride?: number | null;
  defaultDeckIdOverride?: string | null;
  preloadedPlan?: SprintCompoundPlan | DailySprintPlan | null;
}

export interface SprintAnchorRevealResult {
  ok: boolean;
  outcome: string;
  elapsedMs?: number;
}

export type SprintAnchorRevealer = (
  target: string,
  options?: { splitIfClosed?: boolean; pulse?: boolean; signal?: AbortSignal },
) => Promise<SprintAnchorRevealResult>;

export interface SprintLauncherSnapshot {
  isOpen: boolean;
  launchSeq: number;
  launchOptions: OpenDailySprintOptions | null;
  spaceId: string | null;
  rootFolderId: string | null;
  defaultDeckId: string | null;
  config: ExamHorizonConfig | null;
  readiness: ExamReadinessSnapshot | null;
  loadingReadiness: boolean;
}

export const SPRINT_BUDGET_PRESETS = [10, 15, 25, 40] as const;

export function getExamPhaseDotClass(phase: ExamPhase): string {
  switch (phase) {
    case 'foundation':
      return 'bg-emerald-500';
    case 'reinforce':
      return 'bg-amber-500';
    case 'sprint':
      return 'bg-rose-500';
    case 'maintenance':
    case 'unscheduled':
    default:
      return 'bg-primary/70';
  }
}

export function getSourceKindDotClass(kind: SemanticAnchorKind): string {
  switch (kind) {
    case 'mindmap':
      return 'bg-teal-500';
    case 'note':
      return 'bg-emerald-500';
    case 'pdf':
    case 'epub':
      return 'bg-sky-500';
    case 'qbank':
      return 'bg-amber-500';
    case 'media':
      return 'bg-indigo-500';
    case 'custom':
    default:
      return 'bg-primary/70';
  }
}

export function clampSprintBudgetMinutes(value: number | null | undefined, fallback = 15): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(5, Math.min(120, Math.round(value)));
}

export function formatReadinessPercent(ratio: number | null | undefined): string | null {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
  const clamped = Math.max(0, Math.min(1, ratio));
  return `${(clamped * 100).toFixed(1)}%`;
}

export function formatWholePercent(ratio: number | null | undefined): string | null {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
  const clamped = Math.max(0, Math.min(1, ratio));
  return `${Math.round(clamped * 100)}%`;
}

export function formatSignedDeltaPoints(deltaPctPoints: number | null | undefined): string | null {
  if (typeof deltaPctPoints !== 'number' || !Number.isFinite(deltaPctPoints)) return null;
  const rounded = Math.round(deltaPctPoints * 10) / 10;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  const prefix = normalized >= 0 ? '+' : '';
  return `${prefix}${normalized.toFixed(1)}%`;
}

export function formatElapsedTimerMmSs(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatMediaTimestampShort(ms: number): string {
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
