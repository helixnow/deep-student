import { createContext, useContext } from 'react';
import type { GradingMode } from '@/essay-grading/essayGradingApi';
import {
  BUILTIN_MODE_SOURCE,
  getModeDisplayName,
  type ModeI18nT,
} from '@/essay-grading/modeI18n';
import type { ParsedScore } from '@/essay-grading/streamingMarkerParser';

const LOCAL_CUSTOM_RUBRICS_STORAGE_KEY = 'ds.essay_grading.custom_rubrics.v1';

/** Pure mode-ID canonicalizer (matches `src/essay-grading/modeIds.ts` without pulling i18n/invoke side effects) */
function canonicalizeEssayModeId(modeId: string): string {
  const trimmed = modeId.trim();
  switch (trimmed) {
    case 'ielts_task2':
    case 'ielts_writing':
      return 'ielts';
    case 'ielts_task_1':
      return 'ielts_task1';
    case 'cet4':
    case 'cet6':
    case 'cet46':
    case 'cet_46':
      return 'cet';
    case 'gaokao_english_short':
    case 'gaokao_eng_short':
      return 'gaokao_en_short';
    case 'gaokao_english_long':
    case 'gaokao_eng_long':
    case 'gaokao_en_continuation':
      return 'gaokao_en_long';
    default:
      return trimmed;
  }
}

/** Pure localStorage reader for local custom rubrics (avoids importing `essayGradingApi` runtime module) */
function readLocalCustomModes(): GradingMode[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_CUSTOM_RUBRICS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is GradingMode =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as GradingMode).id === 'string' &&
          typeof (item as GradingMode).name === 'string' &&
          (item as GradingMode).name.trim().length > 0 &&
          typeof (item as GradingMode).system_prompt === 'string',
      )
      .map((item) => ({
        ...item,
        is_builtin: false,
        total_max_score:
          typeof item.total_max_score === 'number' &&
          Number.isFinite(item.total_max_score) &&
          item.total_max_score > 0
            ? item.total_max_score
            : 100,
        score_dimensions: Array.isArray(item.score_dimensions) ? item.score_dimensions : [],
        description: typeof item.description === 'string' ? item.description : '',
        created_at: typeof item.created_at === 'string' ? item.created_at : '',
        updated_at: typeof item.updated_at === 'string' ? item.updated_at : '',
      }));
  } catch {
    return [];
  }
}

export interface GradedRubricMeta {
  /** Producing rubric/mode ID (null if inferred solely from score scale) */
  id: string | null;
  /** Localized display name of the rubric that produced the result */
  name: string;
  /** Max score of the rubric that produced the result (null if unknown) */
  maxScore: number | null;
}

export interface SelectedRubricMeta {
  id: string;
  name: string;
  maxScore: number | null;
}

export interface StaleRubricInfo {
  graded: GradedRubricMeta;
  selected: SelectedRubricMeta;
}

export interface EssayRubricResultContextValue {
  staleRubric: StaleRubricInfo | null;
}

export const EssayRubricResultContext = createContext<EssayRubricResultContextValue>({
  staleRubric: null,
});

export function useEssayRubricResultContext(): EssayRubricResultContextValue {
  return useContext(EssayRubricResultContext);
}

/** Built-in mode max scores aligned with Rust `get_builtin_grading_modes()` */
export const BUILTIN_MODE_MAX_SCORES: Readonly<Record<string, number>> = {
  gaokao: 60,
  gaokao_en_short: 15,
  gaokao_en_long: 25,
  ielts: 9,
  ielts_task1: 9,
  kaoyan: 20,
  toefl: 5,
  zhongkao: 50,
  cet: 15,
  practice: 100,
};

type RubricI18nT = (key: string, options?: Record<string, unknown>) => string;

function translateWithFallback(
  t: RubricI18nT,
  key: string,
  fallback: string,
  options?: Record<string, unknown>,
): string {
  const translated = t(key, { ...options, defaultValue: fallback });
  return typeof translated === 'string' && translated && translated !== key ? translated : fallback;
}

export function formatRubricMaxScore(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round((value + Number.EPSILON) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Lightweight fingerprint for a completed grading result string */
export function fingerprintGradingResult(gradingResult: string): string {
  const trimmed = gradingResult.trim();
  if (!trimmed) return '';
  return `${trimmed.length}:${trimmed.slice(0, 160)}:${trimmed.slice(-160)}`;
}

/** Merge prop modes with localStorage custom rubrics (prop modes take precedence) */
export function mergeAvailableRubricModes(modes: GradingMode[]): GradingMode[] {
  const localCustom = readLocalCustomModes();
  if (localCustom.length === 0) return modes;
  const seen = new Set(modes.map((m) => m.id));
  const merged = [...modes];
  for (const local of localCustom) {
    if (!seen.has(local.id)) {
      merged.push(local);
      seen.add(local.id);
    }
  }
  return merged;
}

function findModeById(modes: GradingMode[], modeId: string): GradingMode | undefined {
  const direct = modes.find((m) => m.id === modeId);
  if (direct) return direct;
  const canonical = canonicalizeEssayModeId(modeId);
  return modes.find((m) => canonicalizeEssayModeId(m.id) === canonical);
}

function getBuiltinFallbackMeta(modeId: string, t: ModeI18nT): SelectedRubricMeta | null {
  const canonical = canonicalizeEssayModeId(modeId);
  const builtin = BUILTIN_MODE_SOURCE[canonical];
  if (!builtin) return null;
  return {
    id: canonical,
    name: getModeDisplayName({ id: canonical, name: builtin.name }, t),
    maxScore: BUILTIN_MODE_MAX_SCORES[canonical] ?? null,
  };
}

/** Resolve metadata for a mode ID against loaded modes + builtin table */
export function resolveRubricMetaById(
  modeId: string,
  modes: GradingMode[],
  t: ModeI18nT,
): SelectedRubricMeta {
  const matched = findModeById(modes, modeId);
  if (matched) {
    const maxScore =
      Number.isFinite(matched.total_max_score) && matched.total_max_score > 0
        ? matched.total_max_score
        : (BUILTIN_MODE_MAX_SCORES[canonicalizeEssayModeId(matched.id)] ?? null);
    return {
      id: matched.id,
      name: getModeDisplayName(matched, t),
      maxScore,
    };
  }
  const builtin = getBuiltinFallbackMeta(modeId, t);
  if (builtin) return builtin;
  return {
    id: modeId,
    name: modeId,
    maxScore: null,
  };
}

/** Re-hydrate a cached GradedRubricMeta with fresh localized display name if possible */
export function hydrateGradedRubricMeta(
  meta: GradedRubricMeta,
  modes: GradingMode[],
  t: RubricI18nT,
): GradedRubricMeta {
  if (!meta.id) return meta;
  const matched = findModeById(modes, meta.id);
  if (matched) {
    return {
      id: matched.id,
      name: getModeDisplayName(matched, t as ModeI18nT),
      maxScore:
        meta.maxScore ??
        (Number.isFinite(matched.total_max_score) && matched.total_max_score > 0
          ? matched.total_max_score
          : null),
    };
  }
  const builtin = getBuiltinFallbackMeta(meta.id, t as ModeI18nT);
  if (builtin) {
    return {
      id: builtin.id,
      name: builtin.name,
      maxScore: meta.maxScore ?? builtin.maxScore,
    };
  }
  return meta;
}

function normalizeDimName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();
}

interface RubricCandidate {
  id: string;
  name: string;
  maxScore: number | null;
  dimNames: Set<string>;
}

function buildRubricCandidates(modes: GradingMode[], t: RubricI18nT): RubricCandidate[] {
  const candidates: RubricCandidate[] = [];
  const seenCanonical = new Set<string>();

  for (const mode of modes) {
    const canonical = canonicalizeEssayModeId(mode.id);
    seenCanonical.add(canonical);
    const dimNames = new Set<string>();
    for (const dim of mode.score_dimensions ?? []) {
      const normalized = normalizeDimName(dim.name);
      if (normalized) dimNames.add(normalized);
    }
    const builtin = BUILTIN_MODE_SOURCE[canonical];
    if (builtin) {
      for (const [dimKey, rawName] of Object.entries(builtin.dimensions)) {
        dimNames.add(normalizeDimName(rawName));
        const localized = translateWithFallback(
          t,
          `essay_grading:builtinModes.${canonical}.dimensions.${dimKey}`,
          rawName,
        );
        dimNames.add(normalizeDimName(localized));
      }
    }
    const maxScore =
      Number.isFinite(mode.total_max_score) && mode.total_max_score > 0
        ? mode.total_max_score
        : (BUILTIN_MODE_MAX_SCORES[canonical] ?? null);
    candidates.push({
      id: mode.id,
      name: getModeDisplayName(mode, t as ModeI18nT),
      maxScore,
      dimNames,
    });
  }

  for (const [builtinId, source] of Object.entries(BUILTIN_MODE_SOURCE)) {
    if (seenCanonical.has(builtinId)) continue;
    const dimNames = new Set<string>();
    for (const [dimKey, rawName] of Object.entries(source.dimensions)) {
      dimNames.add(normalizeDimName(rawName));
      const localized = translateWithFallback(
        t,
        `essay_grading:builtinModes.${builtinId}.dimensions.${dimKey}`,
        rawName,
      );
      dimNames.add(normalizeDimName(localized));
    }
    candidates.push({
      id: builtinId,
      name: getModeDisplayName({ id: builtinId, name: source.name }, t as ModeI18nT),
      maxScore: BUILTIN_MODE_MAX_SCORES[builtinId] ?? null,
      dimNames,
    });
  }

  return candidates;
}

export function maxScoresDiffer(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) >= 0.05;
}

/**
 * Infer the producing rubric from a parsed `<score>` block using dimension names
 * and total max score.
 */
export function inferRubricFromParsedScore(
  parsedScore: ParsedScore | null,
  modes: GradingMode[],
  t: RubricI18nT,
): { meta: GradedRubricMeta; strongDimensionMatch: boolean } | null {
  if (!parsedScore) return null;
  const parsedMax =
    Number.isFinite(parsedScore.maxTotal) && parsedScore.maxTotal > 0 ? parsedScore.maxTotal : null;
  const scoreDims = parsedScore.dimensions.map((d) => normalizeDimName(d.name)).filter(Boolean);
  const candidates = buildRubricCandidates(modes, t);

  // 1) Dimension-based match (highest precision; requires maxScore compatibility when both known)
  let bestCandidate: RubricCandidate | null = null;
  let bestOverlap = 0;
  let bestRatio = 0;

  if (scoreDims.length > 0) {
    for (const candidate of candidates) {
      if (candidate.dimNames.size === 0) continue;
      if (parsedMax != null && candidate.maxScore != null && maxScoresDiffer(parsedMax, candidate.maxScore)) {
        continue;
      }
      let overlap = 0;
      for (const dim of scoreDims) {
        if (candidate.dimNames.has(dim)) overlap += 1;
      }
      if (overlap === 0) continue;
      const ratio = overlap / Math.max(scoreDims.length, candidate.dimNames.size);
      if (overlap > bestOverlap || (overlap === bestOverlap && ratio > bestRatio)) {
        bestOverlap = overlap;
        bestRatio = ratio;
        bestCandidate = candidate;
      }
    }
  }

  if (bestCandidate && bestOverlap > 0) {
    return {
      meta: {
        id: bestCandidate.id,
        name: bestCandidate.name,
        maxScore: parsedMax ?? bestCandidate.maxScore,
      },
      // Strong match when >= 2 dimensions match or all parsed dimensions match
      strongDimensionMatch: bestOverlap >= 2 || bestOverlap === scoreDims.length,
    };
  }

  // 2) IELTS 9-band signature (maxTotal === 9 and dimensions each out of 9)
  if (
    parsedMax != null &&
    Math.abs(parsedMax - 9) < 0.05 &&
    parsedScore.dimensions.length >= 2 &&
    parsedScore.dimensions.every((d) => Number.isFinite(d.maxScore) && Math.abs(d.maxScore - 9) < 0.05)
  ) {
    const ieltsMeta = resolveRubricMetaById('ielts', modes, t as ModeI18nT);
    return {
      meta: { id: ieltsMeta.id, name: ieltsMeta.name, maxScore: 9 },
      strongDimensionMatch: true,
    };
  }

  // 3) Unique max-score match across all candidates
  if (parsedMax != null) {
    const matchingMax = candidates.filter(
      (c) => c.maxScore != null && !maxScoresDiffer(c.maxScore, parsedMax),
    );
    if (matchingMax.length === 1) {
      const only = matchingMax[0];
      return {
        meta: { id: only.id, name: only.name, maxScore: parsedMax },
        strongDimensionMatch: false,
      };
    }

    const scaleText = formatRubricMaxScore(parsedMax);
    return {
      meta: {
        id: null,
        name: translateWithFallback(
          t,
          'essay_grading:stale_rubric.scale_fallback',
          `${scaleText}分制标准`,
          { max: scaleText },
        ),
        maxScore: parsedMax,
      },
      strongDimensionMatch: false,
    };
  }

  return null;
}

/**
 * Determine the initial producing rubric for a grading result that has not yet
 * been cached in runtime memory (e.g., opened from saved history or round switch).
 */
export function resolveInitialGradedRubric(params: {
  parsedScore: ParsedScore | null;
  selectedRubric: SelectedRubricMeta;
  modes: GradingMode[];
  t: RubricI18nT;
}): GradedRubricMeta {
  const { parsedScore, selectedRubric, modes, t } = params;
  const parsedMax =
    parsedScore && Number.isFinite(parsedScore.maxTotal) && parsedScore.maxTotal > 0
      ? parsedScore.maxTotal
      : null;
  const inferred = inferRubricFromParsedScore(parsedScore, modes, t);

  // If the score's max score disagrees with the selected rubric, trust the score-inferred rubric
  if (parsedMax != null && maxScoresDiffer(parsedMax, selectedRubric.maxScore)) {
    if (inferred) return inferred.meta;
    const scaleText = formatRubricMaxScore(parsedMax);
    return {
      id: null,
      name: translateWithFallback(
        t,
        'essay_grading:stale_rubric.scale_fallback',
        `${scaleText}分制标准`,
        { max: scaleText },
      ),
      maxScore: parsedMax,
    };
  }

  // If the score's dimensions strongly identify a DIFFERENT rubric than the currently selected one
  if (
    inferred &&
    inferred.strongDimensionMatch &&
    inferred.meta.id &&
    canonicalizeEssayModeId(inferred.meta.id) !== canonicalizeEssayModeId(selectedRubric.id)
  ) {
    return inferred.meta;
  }

  // Otherwise attribute the newly loaded result to the active selected rubric
  return {
    id: selectedRubric.id,
    name: selectedRubric.name,
    maxScore: parsedMax ?? selectedRubric.maxScore,
  };
}

/** Compare graded rubric against currently selected rubric to build StaleRubricInfo */
export function computeStaleRubricInfo(params: {
  hasResult: boolean;
  isGrading: boolean;
  graded: GradedRubricMeta | null;
  selected: SelectedRubricMeta;
}): StaleRubricInfo | null {
  const { hasResult, isGrading, graded, selected } = params;
  if (!hasResult || isGrading || !graded) return null;

  const idMismatch =
    Boolean(graded.id) &&
    Boolean(selected.id) &&
    canonicalizeEssayModeId(graded.id!) !== canonicalizeEssayModeId(selected.id);
  const scaleMismatch = maxScoresDiffer(graded.maxScore, selected.maxScore);

  if (!idMismatch && !scaleMismatch) return null;
  return { graded, selected };
}

export function formatStaleRubricBannerMessage(
  stale: StaleRubricInfo,
  t: RubricI18nT,
): string {
  const gradedMaxText =
    stale.graded.maxScore != null && stale.graded.maxScore > 0
      ? formatRubricMaxScore(stale.graded.maxScore)
      : null;
  const selectedMaxText =
    stale.selected.maxScore != null && stale.selected.maxScore > 0
      ? formatRubricMaxScore(stale.selected.maxScore)
      : null;

  // Avoid redundant "9分制标准（9分制）" when graded rubric fell back to scale-only label
  const scaleFallbackLabel = gradedMaxText
    ? translateWithFallback(
        t,
        'essay_grading:stale_rubric.scale_fallback',
        `${gradedMaxText}分制标准`,
        { max: gradedMaxText },
      )
    : null;
  const gradedNameForScaleBanner =
    !stale.graded.id && scaleFallbackLabel && stale.graded.name === scaleFallbackLabel
      ? translateWithFallback(t, 'essay_grading:stale_rubric.unknown_rubric', '原有评分标准')
      : stale.graded.name;

  if (gradedMaxText && selectedMaxText) {
    return translateWithFallback(
      t,
      'essay_grading:stale_rubric.banner_with_scale',
      `当前展示的是旧评分标准「${gradedNameForScaleBanner}（${gradedMaxText}分制）」的批改结果，与已选标准「${stale.selected.name}（${selectedMaxText}分制）」不一致`,
      {
        gradedRubric: gradedNameForScaleBanner,
        gradedMax: gradedMaxText,
        selectedRubric: stale.selected.name,
        selectedMax: selectedMaxText,
      },
    );
  }

  return translateWithFallback(
    t,
    'essay_grading:stale_rubric.banner_without_scale',
    `当前展示的是旧评分标准「${stale.graded.name}」的批改结果，与已选标准「${stale.selected.name}」不一致`,
    {
      gradedRubric: stale.graded.name,
      selectedRubric: stale.selected.name,
    },
  );
}

export function formatStaleScoreBadgeText(
  graded: GradedRubricMeta,
  t: RubricI18nT,
): string {
  return translateWithFallback(
    t,
    'essay_grading:stale_rubric.score_badge',
    `旧标准结果：${graded.name}`,
    { gradedRubric: graded.name },
  );
}
