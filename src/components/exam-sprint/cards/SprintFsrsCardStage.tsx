import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AnkiTemplateCardFace, OcclusionCardStage } from '@/components/anki/AnkiTemplateCardFace';
import {
  normalizeOcclusionSpec,
  parseOcclusionSpec,
  type OcclusionSpec,
} from '@/components/anki/utils/imageOcclusion';
import type { AnkiCard } from '@/types';
import { cn } from '@/utils/cn';
import { parseCompoundSprintItem, resolveSprintImageSrc } from '../compoundCardModel';
import { resolveItemSourceAnchors } from '../sourceAnchorBridge';
import type {
  ResolvedSprintSourceAnchor,
  SprintCompoundFsrsCardItem,
} from '../sprintContracts';
import {
  SprintBreadcrumbHeader,
  SprintCompoundEvidenceBlocks,
  SprintMathOrPlainText,
  SprintProvenanceBar,
} from './SprintCompoundChrome';

export interface SprintFsrsCardStageProps {
  item: SprintCompoundFsrsCardItem;
  revealed: boolean;
  resolvedAnchors?: readonly ResolvedSprintSourceAnchor[];
  onReveal: () => void;
  onRevealAnchor?: (anchor: ResolvedSprintSourceAnchor) => void;
}

interface ClozeToken {
  kind: 'text' | 'cloze';
  text: string;
  hint: string | null;
}

const CLOZE_TOKEN_RE = /\{\{c\d+::([\s\S]*?)(?:::([\s\S]*?))?\}\}/gi;
const HTML_TAG_RE = /<\/?[a-z][\s\S]*?>/i;

function parsePlainClozeTokens(source: string): ClozeToken[] | null {
  if (!CLOZE_TOKEN_RE.test(source)) return null;
  CLOZE_TOKEN_RE.lastIndex = 0;
  const tokens: ClozeToken[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = CLOZE_TOKEN_RE.exec(source);
  while (match !== null) {
    if (match.index > cursor) {
      tokens.push({
        kind: 'text',
        text: source.slice(cursor, match.index),
        hint: null,
      });
    }
    tokens.push({
      kind: 'cloze',
      text: match[1] ?? '',
      hint: match[2]?.trim() ? match[2].trim() : null,
    });
    cursor = match.index + match[0].length;
    match = CLOZE_TOKEN_RE.exec(source);
  }
  if (cursor < source.length) {
    tokens.push({
      kind: 'text',
      text: source.slice(cursor),
      hint: null,
    });
  }
  return tokens.length > 0 ? tokens : null;
}

export function parseSprintOcclusionData(fields: Record<string, string>): OcclusionSpec | null {
  const fromStandard = parseOcclusionSpec(fields);
  if (fromStandard) return fromStandard;

  const jsonCandidates = [fields.ImageOcclusion, fields.OcclusionMasks];
  for (const raw of jsonCandidates) {
    if (!raw || !raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const spec = normalizeOcclusionSpec(parsed);
      if (spec) return spec;
    } catch {
      // Try next candidate field.
    }
  }

  if (fields.Image && fields.Masks) {
    try {
      const boxes: unknown = JSON.parse(fields.Masks);
      const spec = normalizeOcclusionSpec({
        imageRef: fields.Image,
        boxes,
      });
      if (spec) return spec;
    } catch {
      return null;
    }
  }

  return null;
}

function toAnkiCardModel(item: SprintCompoundFsrsCardItem): AnkiCard {
  return {
    id: item.ankiCardId,
    front: item.front,
    back: item.back,
    text: item.fields.Text ?? item.front,
    fields: item.fields,
    extra_fields: item.fields,
    template_id: item.templateId ?? undefined,
    tags: item.triage.conceptTags,
    images: [],
  };
}

export const SprintFsrsCardStage: React.FC<SprintFsrsCardStageProps> = ({
  item,
  revealed,
  resolvedAnchors: externalAnchors,
  onReveal,
  onRevealAnchor,
}) => {
  const { t } = useTranslation('review');

  const anchors = useMemo(
    () => externalAnchors ?? resolveItemSourceAnchors(item),
    [externalAnchors, item],
  );
  const compound = useMemo(
    () => parseCompoundSprintItem(item, anchors),
    [anchors, item],
  );

  const occlusionSpec = useMemo(
    () => (item.cardFormat === 'image_occlusion' ? parseSprintOcclusionData(item.fields) : null),
    [item.cardFormat, item.fields],
  );
  const occlusionImageSrc = useMemo(
    () => (occlusionSpec ? resolveSprintImageSrc(occlusionSpec.imageRef) : null),
    [occlusionSpec],
  );
  const canRenderOcclusion = occlusionSpec && (occlusionImageSrc || /^vfs:\/\/[^\s]+$/i.test(occlusionSpec.imageRef));

  const clozeSource = compound.displayClozeSource;
  const plainClozeTokens = useMemo(() => {
    if (HTML_TAG_RE.test(clozeSource)) return null;
    return parsePlainClozeTokens(clozeSource);
  }, [clozeSource]);

  const usesHtmlFace = useMemo(
    () =>
      occlusionSpec === null
      && plainClozeTokens === null
      && (Boolean(item.templateId) || HTML_TAG_RE.test(item.front) || HTML_TAG_RE.test(item.back)),
    [item.back, item.front, item.templateId, occlusionSpec, plainClozeTokens],
  );

  const ankiCard = useMemo(() => toAnkiCardModel(item), [item]);
  const rawClozeSource = item.fields.Text || item.front;
  const hasDistinctClozeProse =
    compound.proseBlocks.length > 0
    && compound.proseBlocks.join('\n').trim() !== rawClozeSource.trim()
    && compound.proseBlocks.join('\n').trim() !== clozeSource.trim();

  const hasStructuredEvidence =
    Boolean(compound.personalNote)
    || compound.excerpts.length > 0
    || compound.childBullets.length > 0;

  const trailingMeta =
    item.triage.conceptTags.length > 0
      ? item.triage.conceptTags.slice(0, 2).join(' · ')
      : item.deckName;

  return (
    <div
      className="mx-auto flex w-full max-w-2xl flex-col gap-4"
      data-testid="sprint-fsrs-stage"
      data-card-format={item.cardFormat}
    >
      <div
        onClick={!revealed ? onReveal : undefined}
        className={cn(
          'rounded-xl border border-border/35 bg-card p-5 transition-colors',
          !revealed && 'cursor-pointer hover:bg-card/90',
        )}
      >
        {compound.hasBreadcrumb ? (
          <SprintBreadcrumbHeader
            originKind={compound.originKind}
            crumbs={compound.breadcrumbCrumbs}
            anchorCount={anchors.length}
            trailingMeta={trailingMeta}
          />
        ) : item.deckName ? (
          <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">{item.deckName}</span>
            {item.triage.conceptTags.length > 0 ? (
              <span className="truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                {item.triage.conceptTags.slice(0, 2).join(' · ')}
              </span>
            ) : null}
          </div>
        ) : null}

        {canRenderOcclusion ? (
          <div className="space-y-3">
            {compound.displayFront && !compound.displayFront.includes('data-occlusion') ? (
              <SprintMathOrPlainText text={compound.displayFront} className="text-sm font-medium" />
            ) : null}
            <OcclusionCardStage
              key={item.ankiCardId}
              spec={occlusionSpec}
              imageSrc={occlusionImageSrc}
              side={revealed ? 'back' : 'front'}
              mode={item.fields._occlusion_mode === 'hide-all' ? 'hide-all' : 'hide-one'}
              targetClozeIndex={Number(item.fields._occlusion_target) || 1}
            />
            {revealed && (compound.proseBlocks.length > 0 || hasStructuredEvidence) ? (
              <div className="space-y-3 border-t border-border/35 pt-3 text-sm">
                {compound.proseBlocks.map((block, idx) => (
                  <SprintMathOrPlainText key={idx} text={block} />
                ))}
                <SprintCompoundEvidenceBlocks
                  personalNote={compound.personalNote}
                  excerpts={compound.excerpts}
                  childBullets={compound.childBullets}
                  onRevealAnchor={onRevealAnchor}
                />
              </div>
            ) : null}
          </div>
        ) : plainClozeTokens ? (
          <div className="space-y-4">
            <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-foreground">
              {plainClozeTokens.map((token, idx) => {
                if (token.kind === 'text') {
                  return <React.Fragment key={idx}>{token.text}</React.Fragment>;
                }
                if (!revealed) {
                  return (
                    <span
                      key={idx}
                      data-testid="sprint-cloze-masked"
                      className="mx-0.5 inline-flex items-center rounded border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-sm text-primary"
                    >
                      {token.hint ? `[${token.hint}]` : '[ ... ]'}
                    </span>
                  );
                }
                return (
                  <span
                    key={idx}
                    data-testid="sprint-cloze-revealed"
                    className="mx-0.5 inline-flex items-center rounded border border-primary/30 bg-primary/[0.12] px-1.5 py-0.5 font-medium text-primary"
                  >
                    {token.text}
                  </span>
                );
              })}
            </p>
            {revealed && (hasDistinctClozeProse || hasStructuredEvidence) ? (
              <div className="space-y-3 border-t border-border/35 pt-3 text-sm text-muted-foreground">
                {hasDistinctClozeProse
                  ? compound.proseBlocks.map((block, idx) => (
                      <SprintMathOrPlainText key={idx} text={block} />
                    ))
                  : null}
                <SprintCompoundEvidenceBlocks
                  personalNote={compound.personalNote}
                  excerpts={compound.excerpts}
                  childBullets={compound.childBullets}
                  onRevealAnchor={onRevealAnchor}
                />
              </div>
            ) : null}
          </div>
        ) : usesHtmlFace ? (
          <div className="space-y-4">
            <AnkiTemplateCardFace
              card={ankiCard}
              side={revealed ? 'back' : 'front'}
              compact={false}
              showRenderIssues={false}
            />
            {revealed && hasStructuredEvidence ? (
              <div className="border-t border-border/35 pt-3">
                <SprintCompoundEvidenceBlocks
                  personalNote={compound.personalNote}
                  excerpts={compound.excerpts}
                  childBullets={compound.childBullets}
                  onRevealAnchor={onRevealAnchor}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <SprintMathOrPlainText text={compound.displayFront} className="text-base font-medium" />
            {revealed ? (
              <div className="space-y-3.5 border-t border-border/35 pt-4">
                {compound.proseBlocks.length > 0 ? (
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">
                      {t('card.answer')}
                    </div>
                    {compound.proseBlocks.map((block, idx) => (
                      <SprintMathOrPlainText key={idx} text={block} className="text-sm" />
                    ))}
                  </div>
                ) : null}
                <SprintCompoundEvidenceBlocks
                  personalNote={compound.personalNote}
                  excerpts={compound.excerpts}
                  childBullets={compound.childBullets}
                  onRevealAnchor={onRevealAnchor}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>

      {onRevealAnchor ? (
        <SprintProvenanceBar
          anchors={anchors}
          revealed={revealed}
          primaryButtonTestId="sprint-fsrs-reveal-source"
          onRevealAnchor={onRevealAnchor}
        />
      ) : null}
    </div>
  );
};

export default SprintFsrsCardStage;
