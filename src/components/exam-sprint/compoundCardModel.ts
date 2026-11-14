import { convertFileSrc } from '@tauri-apps/api/core';
import { normalizeSprintAnchorInput } from './sourceAnchorBridge';
import type {
  ResolvedSprintSourceAnchor,
  SemanticAnchorKind,
  SprintCompoundExcerpt,
  SprintCompoundQueueItem,
} from './sprintContracts';

export interface NormalizedCompoundExcerpt {
  id: string;
  kind: 'quote' | 'image' | 'transcript' | 'mistake' | 'note';
  text: string | null;
  latex: string | null;
  imageSrc: string | null;
  sourceLabel: string | null;
  anchor: ResolvedSprintSourceAnchor | null;
}

export interface ParsedCompoundCardModel {
  hasBreadcrumb: boolean;
  originKind: SemanticAnchorKind;
  breadcrumbCrumbs: string[];
  displayFront: string;
  displayClozeSource: string;
  proseBlocks: string[];
  personalNote: string | null;
  excerpts: NormalizedCompoundExcerpt[];
  childBullets: string[];
}

const HTML_TAG_RE = /<\/?[a-z][\s\S]*?>/i;
const BRACKET_PREFIX_RE = /^\s*(?:\[([^\]\n]{2,120})\](?!\()|\u3010([^\u3011\n]{2,120})\u3011)\s*([\s\S]+)$/;
const MASK_PLACEHOLDER_ONLY_RE = /^[.\s?\uff1f\u2026_\-*]+$/;
const PATH_DELIMITER_RE = /\s*(?:\u00b7|>|\u203a|\/|::|->|\u2192)\s*/;
const MD_IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const MD_BULLET_LINE_RE = /^\s*(?:[-*\u2022])\s+(.+)$/;
const MD_BLOCKQUOTE_LINE_RE = /^\s*>\s?(.*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveSprintImageSrc(rawRef: string | null | undefined): string | null {
  if (!rawRef) return null;
  const trimmed = rawRef.trim();
  if (!trimmed) return null;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(trimmed)) return trimmed;
  if (/^(?:https?:\/\/|blob:|asset:\/\/)/i.test(trimmed)) return trimmed;
  // Other protocols are not file paths (javascript:, data:text/html, vfs:, ...).
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) return null;
  if (!/^(?:\/|[a-z]:[\\/])/i.test(trimmed)) return null;
  try {
    return convertFileSrc(trimmed);
  } catch {
    return null;
  }
}

export function extractBracketedAncestorPrefix(rawText: string): {
  crumbs: string[];
  strippedText: string;
} | null {
  if (!rawText || HTML_TAG_RE.test(rawText)) return null;
  const match = BRACKET_PREFIX_RE.exec(rawText);
  if (!match) return null;
  const bracketBody = (match[1] ?? match[2] ?? '').trim();
  const remainder = (match[3] ?? '').trim();
  if (!bracketBody || !remainder) return null;
  if (MASK_PLACEHOLDER_ONLY_RE.test(bracketBody)) return null;
  if (/^c\d+::/i.test(bracketBody)) return null;

  const crumbs = bracketBody
    .split(PATH_DELIMITER_RE)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
  if (crumbs.length === 0) return null;

  return {
    crumbs,
    strippedText: remainder,
  };
}

function parsePathField(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
      }
    } catch {
      // Fall through to delimiter split.
    }
  }
  return trimmed
    .replace(/^\[|\]$/g, '')
    .split(PATH_DELIMITER_RE)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
}

function normalizeOriginKind(raw: unknown): SemanticAnchorKind | null {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  if (lower === 'mindmap') return 'mindmap';
  if (lower === 'pdf' || lower === 'textbook' || lower === 'image_occlusion') return 'pdf';
  if (lower === 'note' || lower === 'markdown') return 'note';
  if (lower === 'qbank' || lower === 'mistake' || lower === 'exam') return 'qbank';
  if (lower === 'media' || lower === 'video' || lower === 'audio') return 'media';
  if (lower === 'epub') return 'epub';
  if (lower === 'custom') return 'custom';
  return null;
}

function matchAnchorForQuote(
  quoteText: string | null,
  anchors: readonly ResolvedSprintSourceAnchor[],
): ResolvedSprintSourceAnchor | null {
  if (!quoteText) return null;
  const needle = quoteText.trim();
  if (!needle) return null;
  for (const anchor of anchors) {
    if (!anchor.quote) continue;
    const aq = anchor.quote.trim();
    if (!aq) continue;
    if (needle.includes(aq) || aq.includes(needle)) {
      return anchor;
    }
  }
  return null;
}

function normalizeStructuredExcerpt(
  raw: SprintCompoundExcerpt | unknown,
  index: number,
  anchors: readonly ResolvedSprintSourceAnchor[],
): NormalizedCompoundExcerpt | null {
  if (!isRecord(raw)) return null;

  const rawImage =
    cleanText(raw.imageDataUrl) ?? cleanText(raw.imageAsset) ?? cleanText(raw.imageUrl);
  const imageSrc = resolveSprintImageSrc(rawImage);
  const text = cleanText(raw.text) ?? cleanText(raw.quote) ?? cleanText(raw.extractedText);
  const latex = cleanText(raw.latex);
  const sourceLabel = cleanText(raw.sourceLabel) ?? cleanText(raw.sourceTitle);

  let anchor: ResolvedSprintSourceAnchor | null = null;
  if (raw.anchor) {
    anchor = normalizeSprintAnchorInput(raw.anchor);
  } else if (typeof raw.anchorUri === 'string') {
    anchor = normalizeSprintAnchorInput(raw.anchorUri);
  }
  if (!anchor && text) {
    anchor = matchAnchorForQuote(text, anchors);
  }

  let kind: NormalizedCompoundExcerpt['kind'] = 'quote';
  if (
    raw.kind === 'image'
    || raw.excerptKind === 'region-image'
    || (imageSrc !== null && !raw.kind)
  ) {
    kind = 'image';
  } else if (raw.kind === 'transcript' || raw.excerptKind === 'transcript-cue') {
    kind = 'transcript';
  } else if (raw.kind === 'mistake') {
    kind = 'mistake';
  } else if (raw.kind === 'note') {
    kind = 'note';
  }

  if (!text && !imageSrc && !latex) return null;

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `excerpt_${index}`,
    kind,
    text,
    latex,
    imageSrc,
    sourceLabel,
    anchor,
  };
}

function parseExcerptsFromFields(
  rawField: string | undefined,
  anchors: readonly ResolvedSprintSourceAnchor[],
): NormalizedCompoundExcerpt[] {
  if (!rawField || !rawField.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(rawField);
    if (!Array.isArray(parsed)) return [];
    const out: NormalizedCompoundExcerpt[] = [];
    parsed.forEach((entry, idx) => {
      const norm = normalizeStructuredExcerpt(entry, idx, anchors);
      if (norm) out.push(norm);
    });
    return out;
  } catch {
    return [];
  }
}

function parseBulletField(rawField: string | undefined): string[] {
  if (!rawField || !rawField.trim()) return [];
  const trimmed = rawField.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
      }
    } catch {
      // Fall back to line split.
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\d+\.)\s*/, '').trim())
    .filter((line) => line.length > 0);
}

function parseMarkdownBackStructure(
  rawBack: string,
  anchors: readonly ResolvedSprintSourceAnchor[],
): {
  proseBlocks: string[];
  excerpts: NormalizedCompoundExcerpt[];
  bullets: string[];
} {
  if (!rawBack || !rawBack.trim()) {
    return { proseBlocks: [], excerpts: [], bullets: [] };
  }
  if (HTML_TAG_RE.test(rawBack)) {
    return { proseBlocks: [rawBack.trim()], excerpts: [], bullets: [] };
  }

  const lines = rawBack.split(/\r?\n/);
  const proseBlocks: string[] = [];
  const excerpts: NormalizedCompoundExcerpt[] = [];
  const bullets: string[] = [];

  let currentProse: string[] = [];
  let currentQuote: string[] = [];
  let excerptSeq = 0;

  const flushProse = () => {
    if (currentProse.length === 0) return;
    const joined = currentProse.join('\n').trim();
    if (joined) proseBlocks.push(joined);
    currentProse = [];
  };

  const flushQuote = () => {
    if (currentQuote.length === 0) return;
    const joined = currentQuote.join('\n').trim();
    if (joined) {
      excerpts.push({
        id: `md_quote_${excerptSeq++}`,
        kind: 'quote',
        text: joined,
        latex: null,
        imageSrc: null,
        sourceLabel: null,
        anchor: matchAnchorForQuote(joined, anchors),
      });
    }
    currentQuote = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushQuote();
      flushProse();
      continue;
    }

    const quoteMatch = MD_BLOCKQUOTE_LINE_RE.exec(rawLine);
    if (quoteMatch) {
      flushProse();
      currentQuote.push(quoteMatch[1] ?? '');
      continue;
    }
    flushQuote();

    const imgMatch = MD_IMAGE_LINE_RE.exec(trimmed);
    if (imgMatch) {
      flushProse();
      const alt = (imgMatch[1] ?? '').trim() || null;
      const src = resolveSprintImageSrc(imgMatch[2] ?? '');
      if (src) {
        excerpts.push({
          id: `md_img_${excerptSeq++}`,
          kind: 'image',
          text: alt,
          latex: null,
          imageSrc: src,
          sourceLabel: null,
          anchor: null,
        });
      }
      continue;
    }

    const bulletMatch = MD_BULLET_LINE_RE.exec(rawLine);
    if (bulletMatch) {
      flushProse();
      const bulletText = (bulletMatch[1] ?? '').trim();
      if (bulletText) bullets.push(bulletText);
      continue;
    }

    currentProse.push(rawLine);
  }

  flushQuote();
  flushProse();

  return { proseBlocks, excerpts, bullets };
}

export function parseCompoundSprintItem(
  item: SprintCompoundQueueItem,
  resolvedAnchors: readonly ResolvedSprintSourceAnchor[],
): ParsedCompoundCardModel {
  let explicitCrumbs: string[] = [];
  if (Array.isArray(item.ancestorPath) && item.ancestorPath.length > 0) {
    explicitCrumbs = item.ancestorPath
      .filter((seg): seg is string => typeof seg === 'string')
      .map((seg) => seg.trim())
      .filter((seg) => seg.length > 0);
  }

  let displayFront = item.kind === 'fsrs_card' ? item.front : '';
  let displayClozeSource =
    item.kind === 'fsrs_card' ? item.fields.Text || item.front : '';
  let hadBracketPrefix = false;

  if (item.kind === 'fsrs_card') {
    if (explicitCrumbs.length === 0) {
      const fieldPath =
        parsePathField(item.fields.AncestorPath)
          .concat()
          .length > 0
          ? parsePathField(item.fields.AncestorPath)
          : parsePathField(
              item.fields.ancestorPath ?? item.fields.Breadcrumb ?? item.fields.Path,
            );
      if (fieldPath.length > 0) {
        explicitCrumbs = fieldPath;
      }
    }

    const extractedFront = extractBracketedAncestorPrefix(item.front);
    if (extractedFront) {
      hadBracketPrefix = true;
      if (explicitCrumbs.length === 0) {
        explicitCrumbs = extractedFront.crumbs;
      }
      displayFront = extractedFront.strippedText;
    }

    const rawCloze = item.fields.Text || item.front;
    const extractedCloze = extractBracketedAncestorPrefix(rawCloze);
    if (extractedCloze) {
      hadBracketPrefix = true;
      if (explicitCrumbs.length === 0) {
        explicitCrumbs = extractedCloze.crumbs;
      }
      displayClozeSource = extractedCloze.strippedText;
    }
  } else if (item.kind === 'mindmap_cloze' && explicitCrumbs.length === 0) {
    explicitCrumbs = [item.mindmapTitle].filter((s) => s.trim().length > 0);
  }

  const fieldKind =
    item.kind === 'fsrs_card'
      ? normalizeOriginKind(item.fields.SourceKind ?? item.fields.sourceKind)
      : null;
  const projectedKind = normalizeOriginKind(item.projectedSourceKind) ?? fieldKind;

  let originKind: SemanticAnchorKind;
  if (projectedKind) {
    originKind = projectedKind;
  } else if (item.kind === 'mindmap_cloze') {
    originKind = 'mindmap';
  } else if (item.kind === 'fsrs_card' && item.cardFormat === 'image_occlusion') {
    originKind = resolvedAnchors[0]?.kind ?? 'pdf';
  } else if (resolvedAnchors.length > 0) {
    originKind = resolvedAnchors[0]!.kind;
  } else if (item.kind === 'mistake_question') {
    originKind = 'qbank';
  } else if (hadBracketPrefix) {
    originKind = 'mindmap';
  } else {
    originKind = 'note';
  }

  let breadcrumbCrumbs = explicitCrumbs;
  if (breadcrumbCrumbs.length === 0 && resolvedAnchors.length > 1) {
    if (item.kind === 'fsrs_card' && item.deckName) {
      breadcrumbCrumbs = parsePathField(item.deckName);
    } else if (item.kind === 'mistake_question' && item.examName) {
      breadcrumbCrumbs = [item.examName];
    } else if (resolvedAnchors[0]?.label) {
      breadcrumbCrumbs = [resolvedAnchors[0].label];
    }
  }

  const hasBreadcrumb =
    item.kind === 'mindmap_cloze'
    || breadcrumbCrumbs.length > 0
    || resolvedAnchors.length > 1
    || Boolean(projectedKind);

  const structuredExcerpts: NormalizedCompoundExcerpt[] = [];
  if (Array.isArray(item.excerpts)) {
    item.excerpts.forEach((ex, idx) => {
      const norm = normalizeStructuredExcerpt(ex, idx, resolvedAnchors);
      if (norm) structuredExcerpts.push(norm);
    });
  }
  if (item.kind === 'fsrs_card') {
    const fromField = parseExcerptsFromFields(
      item.fields.Excerpts ?? item.fields.excerpts,
      resolvedAnchors,
    );
    structuredExcerpts.push(...fromField);
  }

  const structuredBullets: string[] = [];
  if (Array.isArray(item.childSummaries)) {
    for (const bullet of item.childSummaries) {
      if (typeof bullet === 'string' && bullet.trim()) {
        structuredBullets.push(bullet.trim());
      }
    }
  }
  if (item.kind === 'fsrs_card') {
    structuredBullets.push(
      ...parseBulletField(
        item.fields.ChildSummaries ?? item.fields.childSummaries ?? item.fields.Subpoints,
      ),
    );
  }

  const personalNote =
    cleanText(item.personalNote)
    ?? (item.kind === 'fsrs_card'
      ? cleanText(item.fields.PersonalNote ?? item.fields.Annotation)
      : null);

  let proseBlocks: string[] = [];
  const markdownExcerpts: NormalizedCompoundExcerpt[] = [];
  const markdownBullets: string[] = [];

  if (item.kind === 'fsrs_card' && item.back) {
    const parsedBack = parseMarkdownBackStructure(item.back, resolvedAnchors);
    proseBlocks = parsedBack.proseBlocks;
    markdownExcerpts.push(...parsedBack.excerpts);
    markdownBullets.push(...parsedBack.bullets);
  }

  const allExcerpts = [...structuredExcerpts, ...markdownExcerpts];
  const allBullets = [...new Set([...structuredBullets, ...markdownBullets])];

  // When a multi-source compound card carries anchor quotes not yet shown in prose/excerpts,
  // surface them cleanly on the revealed back face with 1-click anchor linkage.
  if (resolvedAnchors.length > 1) {
    const existingTextCorpus = [
      ...proseBlocks,
      personalNote ?? '',
      ...allExcerpts.map((e) => e.text ?? ''),
      item.kind === 'mindmap_cloze' ? item.fullText : '',
    ].join('\n');

    resolvedAnchors.forEach((anchor, idx) => {
      if (!anchor.quote) return;
      const q = anchor.quote.trim();
      if (!q || existingTextCorpus.includes(q)) return;
      allExcerpts.push({
        id: `anchor_quote_${idx}`,
        kind: 'quote',
        text: q,
        latex: null,
        imageSrc: null,
        sourceLabel: anchor.label,
        anchor,
      });
    });
  }

  return {
    hasBreadcrumb,
    originKind,
    breadcrumbCrumbs,
    displayFront,
    displayClozeSource,
    proseBlocks,
    personalNote,
    excerpts: allExcerpts,
    childBullets: allBullets,
  };
}
