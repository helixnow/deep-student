import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  parseSemanticAnchor,
  sanitizeSemanticAnchor,
  serializeSemanticAnchor,
  type SemanticAnchor,
  type SemanticAnchorKind,
} from '@/ui-kernel/contracts/interop';
import {
  formatMediaTimestampShort,
  type ResolvedSprintSourceAnchor,
  type SprintAnchorInput,
  type SprintAnchorRevealResult,
  type SprintAnchorRevealer,
  type SprintCompoundQueueItem,
  type SprintSourceAnchor,
} from './sprintContracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableTrimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAnchorKind(raw: unknown): SemanticAnchorKind | null {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  if (lower === 'pdf' || lower === 'textbook' || lower === 'file') return 'pdf';
  if (lower === 'epub') return 'epub';
  if (lower === 'media' || lower === 'video' || lower === 'audio' || lower === 'bilibili') {
    return 'media';
  }
  if (lower === 'note' || lower === 'markdown') return 'note';
  if (lower === 'mindmap') return 'mindmap';
  if (lower === 'qbank' || lower === 'question' || lower === 'exam') return 'qbank';
  if (lower === 'custom') return 'custom';
  return null;
}

function resolvedFromSemanticAnchor(
  semantic: SemanticAnchor,
  explicitCanonicalUri?: string | null,
): ResolvedSprintSourceAnchor {
  const canonicalUri =
    explicitCanonicalUri && explicitCanonicalUri.startsWith('ds-anchor://v1/')
      ? explicitCanonicalUri
      : serializeSemanticAnchor(semantic);

  return {
    canonicalUri,
    semanticAnchor: semantic,
    kind: semantic.kind,
    resourceId: semantic.resourceId,
    label: semantic.label ?? null,
    page: semantic.kind === 'pdf' ? semantic.page : null,
    startMs: semantic.kind === 'media' ? semantic.startMs : null,
    endMs: semantic.kind === 'media' && semantic.endMs !== undefined ? semantic.endMs : null,
    blockId: semantic.kind === 'note' ? (semantic.blockId ?? null) : null,
    nodeId: semantic.kind === 'mindmap' ? (semantic.nodeId ?? null) : null,
    questionId: semantic.kind === 'qbank' ? (semantic.questionId ?? null) : null,
    quote:
      'quote' in semantic && typeof semantic.quote === 'string' && semantic.quote.length > 0
        ? semantic.quote
        : null,
  };
}

function parseLegacyDsAnchorUri(rawUri: string): ResolvedSprintSourceAnchor | null {
  const trimmed = rawUri.trim();
  if (!trimmed.startsWith('ds-anchor://v1/')) return null;

  const strict = parseSemanticAnchor(trimmed);
  if (strict) {
    return resolvedFromSemanticAnchor(strict, trimmed);
  }

  const rest = trimmed.slice('ds-anchor://v1/'.length);
  const qIndex = rest.indexOf('?');
  const pathPart = qIndex >= 0 ? rest.slice(0, qIndex) : rest;
  const queryPart = qIndex >= 0 ? rest.slice(qIndex + 1) : '';
  const segments = pathPart.split('/').filter((seg) => seg.length > 0);
  if (segments.length < 2) return null;

  const kind = normalizeAnchorKind(segments[0]);
  if (!kind || kind === 'custom' || kind === 'epub') return null;

  let resourceId: string;
  try {
    resourceId = decodeURIComponent(segments[1]!);
  } catch {
    resourceId = segments[1]!;
  }
  if (!resourceId.trim()) return null;

  const params = new URLSearchParams(queryPart);
  const pageRaw = params.get('page') ?? params.get('p');
  const page =
    pageRaw !== null && Number.isFinite(Number(pageRaw)) && Number(pageRaw) >= 1
      ? Math.trunc(Number(pageRaw))
      : null;

  const startRaw = params.get('t') ?? params.get('startMs') ?? params.get('ms');
  const startMs =
    startRaw !== null && Number.isFinite(Number(startRaw)) && Number(startRaw) >= 0
      ? Math.trunc(Number(startRaw))
      : null;

  const endRaw = params.get('end') ?? params.get('endMs');
  const endMs =
    endRaw !== null && Number.isFinite(Number(endRaw)) && Number(endRaw) >= 0
      ? Math.trunc(Number(endRaw))
      : null;

  const blockId = nullableTrimmed(params.get('block') ?? params.get('blockId'));
  const nodeId = nullableTrimmed(params.get('node') ?? params.get('nodeId'));
  const questionId = nullableTrimmed(params.get('q') ?? params.get('question') ?? params.get('questionId'));
  const quote = nullableTrimmed(params.get('quote'));
  const label = nullableTrimmed(params.get('label'));

  const candidateSemantic = buildBestEffortSemanticAnchor({
    kind,
    resourceId,
    label,
    page,
    startMs,
    endMs,
    blockId,
    nodeId,
    questionId,
    quote,
  });

  return {
    canonicalUri: trimmed,
    semanticAnchor: candidateSemantic,
    kind,
    resourceId,
    label,
    page,
    startMs,
    endMs,
    blockId,
    nodeId,
    questionId,
    quote,
  };
}

function buildBestEffortSemanticAnchor(fields: {
  kind: SemanticAnchorKind;
  resourceId: string;
  label: string | null;
  page: number | null;
  startMs: number | null;
  endMs?: number | null;
  blockId: string | null;
  nodeId: string | null;
  questionId: string | null;
  quote: string | null;
}): SemanticAnchor | null {
  const base = {
    resourceId: fields.resourceId,
    ...(fields.label ? { label: fields.label } : {}),
  };
  switch (fields.kind) {
    case 'pdf':
      return sanitizeSemanticAnchor({
        kind: 'pdf',
        ...base,
        page: fields.page !== null && fields.page >= 1 ? fields.page : 1,
        ...(fields.quote ? { quote: fields.quote } : {}),
      });
    case 'media':
      return sanitizeSemanticAnchor({
        kind: 'media',
        ...base,
        startMs: fields.startMs !== null && fields.startMs >= 0 ? fields.startMs : 0,
        ...(fields.endMs !== null && fields.endMs !== undefined ? { endMs: fields.endMs } : {}),
        ...(fields.quote ? { quote: fields.quote } : {}),
      });
    case 'note':
      return sanitizeSemanticAnchor({
        kind: 'note',
        ...base,
        ...(fields.blockId ? { blockId: fields.blockId } : {}),
      });
    case 'mindmap':
      return sanitizeSemanticAnchor({
        kind: 'mindmap',
        ...base,
        ...(fields.nodeId ? { nodeId: fields.nodeId } : {}),
      });
    case 'qbank':
      return sanitizeSemanticAnchor({
        kind: 'qbank',
        ...base,
        ...(fields.questionId ? { questionId: fields.questionId } : {}),
      });
    default:
      return null;
  }
}

export function normalizeSprintAnchorInput(
  raw: SprintAnchorInput | unknown,
): ResolvedSprintSourceAnchor | null {
  if (typeof raw === 'string') {
    return parseLegacyDsAnchorUri(raw);
  }
  if (!isRecord(raw)) return null;

  // 1. Direct `SemanticAnchor` from `@/ui-kernel/contracts/interop`
  const directSemantic = sanitizeSemanticAnchor(raw);
  if (directSemantic && !('anchorUri' in raw)) {
    return resolvedFromSemanticAnchor(directSemantic);
  }

  // 2. `SprintSourceAnchor` or serialized hybrid anchor record
  const explicitUri = nullableTrimmed(raw.anchorUri);
  const kind = normalizeAnchorKind(raw.kind);
  const resourceId = nullableTrimmed(raw.resourceId);

  if (!kind || !resourceId) {
    return explicitUri ? parseLegacyDsAnchorUri(explicitUri) : null;
  }

  const page =
    typeof raw.page === 'number' && Number.isFinite(raw.page) && raw.page >= 1
      ? Math.trunc(raw.page)
      : null;
  const startMs =
    typeof raw.startMs === 'number' && Number.isFinite(raw.startMs) && raw.startMs >= 0
      ? Math.trunc(raw.startMs)
      : null;
  const endMs =
    typeof raw.endMs === 'number' && Number.isFinite(raw.endMs) && raw.endMs >= 0
      ? Math.trunc(raw.endMs)
      : null;
  const blockId = nullableTrimmed(raw.blockId);
  const nodeId = nullableTrimmed(raw.nodeId);
  const questionId = nullableTrimmed(raw.questionId);
  const quote = nullableTrimmed(raw.quote);
  const label = nullableTrimmed(raw.label);

  const semantic =
    directSemantic
    ?? buildBestEffortSemanticAnchor({
      kind,
      resourceId,
      label,
      page,
      startMs,
      endMs,
      blockId,
      nodeId,
      questionId,
      quote,
    });

  let canonicalUri: string;
  if (explicitUri && explicitUri.startsWith('ds-anchor://v1/')) {
    canonicalUri = explicitUri;
  } else if (semantic) {
    canonicalUri = serializeSemanticAnchor(semantic);
  } else {
    canonicalUri = `ds-anchor://v1/${kind}/${encodeURIComponent(resourceId)}`;
  }

  return {
    canonicalUri,
    semanticAnchor: semantic,
    kind,
    resourceId,
    label,
    page,
    startMs,
    endMs,
    blockId,
    nodeId,
    questionId,
    quote,
  };
}

export function buildCanonicalSprintAnchorUri(anchor: SprintAnchorInput): string {
  const normalized = normalizeSprintAnchorInput(anchor);
  if (normalized) return normalized.canonicalUri;
  if (typeof anchor === 'string') return anchor.trim();
  return `ds-anchor://v1/${anchor.kind}/${encodeURIComponent(anchor.resourceId)}`;
}

function parseJsonAnchorList(rawJson: string | undefined): ResolvedSprintSourceAnchor[] {
  if (!rawJson || !rawJson.trim()) return [];
  const trimmed = rawJson.trim();
  if (trimmed.startsWith('ds-anchor://v1/')) {
    const single = normalizeSprintAnchorInput(trimmed);
    return single ? [single] : [];
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const out: ResolvedSprintSourceAnchor[] = [];
      for (const entry of parsed) {
        const norm = normalizeSprintAnchorInput(entry);
        if (norm) out.push(norm);
      }
      return out;
    }
    const single = normalizeSprintAnchorInput(parsed);
    return single ? [single] : [];
  } catch {
    return [];
  }
}

function dedupeAnchorIdentity(anchor: ResolvedSprintSourceAnchor): string {
  return [
    anchor.kind,
    anchor.resourceId,
    anchor.page ?? '',
    anchor.startMs ?? '',
    anchor.blockId ?? '',
    anchor.nodeId ?? '',
    anchor.questionId ?? '',
  ].join('|');
}

export function resolveItemSourceAnchors(
  item: SprintCompoundQueueItem,
): ResolvedSprintSourceAnchor[] {
  const ordered: ResolvedSprintSourceAnchor[] = [];
  const seenUris = new Set<string>();
  const seenIdentities = new Set<string>();

  const pushAnchor = (candidate: unknown) => {
    const normalized = normalizeSprintAnchorInput(candidate);
    if (!normalized) return;
    const identity = dedupeAnchorIdentity(normalized);
    if (seenUris.has(normalized.canonicalUri) || seenIdentities.has(identity)) return;
    seenUris.add(normalized.canonicalUri);
    seenIdentities.add(identity);
    ordered.push(normalized);
  };

  if (Array.isArray(item.sourceAnchors)) {
    for (const entry of item.sourceAnchors) {
      pushAnchor(entry);
    }
  }

  if (item.kind === 'fsrs_card') {
    const fieldCandidates = [
      item.fields.SourceAnchors,
      item.fields.source_anchors,
      item.fields.Anchors,
      item.fields.anchors,
    ];
    for (const rawField of fieldCandidates) {
      for (const parsed of parseJsonAnchorList(rawField)) {
        pushAnchor(parsed);
      }
    }
  } else if (item.kind === 'mistake_question' && isRecord(item.structuredData)) {
    const sdAnchors = item.structuredData.sourceAnchors ?? item.structuredData.anchors;
    if (Array.isArray(sdAnchors)) {
      for (const entry of sdAnchors) {
        pushAnchor(entry);
      }
    }
  }

  if (Array.isArray(item.excerpts)) {
    for (const excerpt of item.excerpts) {
      if (excerpt?.anchor) pushAnchor(excerpt.anchor);
      else if (excerpt?.anchorUri) pushAnchor(excerpt.anchorUri);
    }
  }

  if (item.kind === 'fsrs_card') {
    const rawExcerptsJson = item.fields.Excerpts ?? item.fields.excerpts;
    if (rawExcerptsJson && rawExcerptsJson.trim()) {
      try {
        const parsedExcerpts: unknown = JSON.parse(rawExcerptsJson);
        if (Array.isArray(parsedExcerpts)) {
          for (const ex of parsedExcerpts) {
            if (isRecord(ex)) {
              if (ex.anchor) pushAnchor(ex.anchor);
              else if (typeof ex.anchorUri === 'string') pushAnchor(ex.anchorUri);
            }
          }
        }
      } catch {
        // Ignore non-JSON Excerpts field.
      }
    }
  }

  if (item.sourceAnchor) {
    pushAnchor(item.sourceAnchor);
  }

  return ordered;
}

export function formatProvenancePillLabel(
  anchor: ResolvedSprintSourceAnchor,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (anchor.kind) {
    case 'pdf':
      if (anchor.page !== null && anchor.page >= 1) {
        return `P.${anchor.page}`;
      }
      return t('examSprint.player.provenance.pdf');
    case 'mindmap':
      return t('examSprint.player.provenance.mindmapNode');
    case 'media':
      if (anchor.startMs !== null && anchor.startMs >= 0) {
        return formatMediaTimestampShort(anchor.startMs);
      }
      return t('examSprint.player.provenance.media');
    case 'note':
      return t('examSprint.player.provenance.noteBlock');
    case 'qbank':
      return t('examSprint.player.provenance.qbankQuestion');
    case 'epub':
      return t('examSprint.player.provenance.epub');
    case 'custom':
    default:
      return anchor.label ?? t('examSprint.player.provenance.source');
  }
}

function buildFallbackDstuPath(anchor: ResolvedSprintSourceAnchor): string {
  switch (anchor.kind) {
    case 'note':
      return `/notes/${anchor.resourceId}`;
    case 'mindmap':
      return `/mindmaps/${anchor.resourceId}`;
    case 'qbank':
      return `/exams/${anchor.resourceId}`;
    case 'pdf':
    case 'epub':
    case 'media':
    case 'custom':
    default:
      return `/files/${anchor.resourceId}`;
  }
}

async function fallbackRevealViaHostNavigation(
  anchor: ResolvedSprintSourceAnchor,
): Promise<boolean> {
  try {
    const { openResource } = await import('@/dstu/openResource');
    const result = await openResource(buildFallbackDstuPath(anchor));
    if (result.ok) {
      return true;
    }
  } catch {
    // Continue to view-switch event fallback.
  }

  try {
    const targetView =
      anchor.kind === 'pdf' || anchor.kind === 'epub'
        ? 'pdf-reader'
        : anchor.kind === 'media'
          ? 'media'
          : 'learning-hub';
    dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: targetView });
    return true;
  } catch {
    return false;
  }
}

export async function revealSprintSourceAnchor(
  target: ResolvedSprintSourceAnchor | SprintAnchorInput | SprintSourceAnchor,
  options?: { anchorRevealer?: SprintAnchorRevealer },
): Promise<SprintAnchorRevealResult> {
  const resolved =
    isRecord(target) && typeof target.canonicalUri === 'string' && 'semanticAnchor' in target
      ? (target as unknown as ResolvedSprintSourceAnchor)
      : normalizeSprintAnchorInput(target);

  if (!resolved) {
    return { ok: false, outcome: 'invalid-anchor' };
  }

  if (options?.anchorRevealer) {
    try {
      const res = await options.anchorRevealer(resolved.canonicalUri, {
        splitIfClosed: true,
        pulse: true,
      });
      if (res.ok) return res;
    } catch {
      // Fall through to deterministic navigation fallback.
    }
  } else {
    try {
      const kernel = getAppKernel();
      const res = await kernel.anchors.reveal(
        resolved.semanticAnchor ?? resolved.canonicalUri,
        { splitIfClosed: true, pulse: true },
      );
      if (res.ok) return res;
    } catch {
      // Fall through to deterministic navigation fallback.
    }
  }

  const fallbackOk = await fallbackRevealViaHostNavigation(resolved);
  return {
    ok: fallbackOk,
    outcome: fallbackOk ? 'opened-via-host-fallback' : 'unhandled',
  };
}
