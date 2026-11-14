import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { parseCompoundSprintItem } from '../compoundCardModel';
import { resolveItemSourceAnchors } from '../sourceAnchorBridge';
import type {
  ResolvedSprintSourceAnchor,
  SprintCompoundMindmapClozeItem,
} from '../sprintContracts';
import {
  SprintBreadcrumbHeader,
  SprintCompoundEvidenceBlocks,
  SprintProvenanceBar,
} from './SprintCompoundChrome';

export interface SprintMindmapClozeStageProps {
  item: SprintCompoundMindmapClozeItem;
  revealed: boolean;
  resolvedAnchors?: readonly ResolvedSprintSourceAnchor[];
  onReveal: () => void;
  onRevealAnchor: (anchor: ResolvedSprintSourceAnchor) => void;
}

const FULLWIDTH_MASK_TOKEN = '\uff3b \uff1f \uff3d';

interface ClozeRenderSegment {
  kind: 'plain' | 'blank';
  text: string;
}

function buildMaskedSegments(item: SprintCompoundMindmapClozeItem): ClozeRenderSegment[] {
  if (item.maskedText.includes(FULLWIDTH_MASK_TOKEN)) {
    const parts = item.maskedText.split(FULLWIDTH_MASK_TOKEN);
    const segments: ClozeRenderSegment[] = [];
    parts.forEach((part, index) => {
      if (part.length > 0) {
        segments.push({ kind: 'plain', text: part });
      }
      if (index < parts.length - 1) {
        segments.push({ kind: 'blank', text: FULLWIDTH_MASK_TOKEN });
      }
    });
    return segments;
  }

  if (item.blankedRanges.length > 0 && item.fullText.length > 0) {
    const segments: ClozeRenderSegment[] = [];
    let cursor = 0;
    for (const range of validBlankedRanges(item)) {
      const start = Math.max(cursor, Math.min(item.fullText.length, range.start));
      const end = Math.max(start, Math.min(item.fullText.length, range.end));
      if (start > cursor) {
        segments.push({ kind: 'plain', text: item.fullText.slice(cursor, start) });
      }
      if (end > start) {
        segments.push({ kind: 'blank', text: FULLWIDTH_MASK_TOKEN });
      }
      cursor = Math.max(cursor, end);
    }
    if (cursor < item.fullText.length) {
      segments.push({ kind: 'plain', text: item.fullText.slice(cursor) });
    }
    if (segments.length > 0) return segments;
  }

  return [{ kind: 'blank', text: FULLWIDTH_MASK_TOKEN }];
}

function buildRevealedSegments(item: SprintCompoundMindmapClozeItem): ClozeRenderSegment[] {
  if (item.blankedRanges.length === 0 || item.fullText.length === 0) {
    return [{ kind: 'blank', text: item.fullText }];
  }
  const sorted = validBlankedRanges(item);
  const segments: ClozeRenderSegment[] = [];
  let cursor = 0;
  for (const range of sorted) {
    const start = Math.max(cursor, Math.min(item.fullText.length, range.start));
    const end = Math.max(start, Math.min(item.fullText.length, range.end));
    if (start > cursor) {
      segments.push({ kind: 'plain', text: item.fullText.slice(cursor, start) });
    }
    if (end > start) {
      segments.push({ kind: 'blank', text: item.fullText.slice(start, end) });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < item.fullText.length) {
    segments.push({ kind: 'plain', text: item.fullText.slice(cursor) });
  }
  return segments;
}

function validBlankedRanges(item: SprintCompoundMindmapClozeItem) {
  return item.blankedRanges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export const SprintMindmapClozeStage: React.FC<SprintMindmapClozeStageProps> = ({
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

  const breadcrumbs = useMemo(
    () => (item.ancestorPath.length > 0 ? item.ancestorPath : [item.mindmapTitle]),
    [item.ancestorPath, item.mindmapTitle],
  );
  const maskedSegments = useMemo(() => buildMaskedSegments(item), [item]);
  const revealedSegments = useMemo(() => buildRevealedSegments(item), [item]);

  const hasStructuredEvidence =
    Boolean(compound.personalNote)
    || compound.excerpts.length > 0
    || compound.childBullets.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4" data-testid="sprint-mindmap-stage">
      <div
        onClick={!revealed ? onReveal : undefined}
        className={cn(
          'rounded-xl border border-border/35 bg-card p-5 transition-colors',
          !revealed && 'cursor-pointer hover:bg-card/90',
        )}
      >
        <SprintBreadcrumbHeader
          originKind="mindmap"
          crumbs={breadcrumbs}
          anchorCount={anchors.length}
          navTestId="sprint-mindmap-ancestors"
          ariaLabel={item.mindmapTitle}
        />

        {item.siblingHints.length > 0 ? (
          <div className="mb-4 space-y-1.5">
            <div className="text-[11px] font-medium text-muted-foreground">
              {t('examSprint.player.siblingContext')}
            </div>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="sprint-mindmap-siblings">
              {item.siblingHints.map((sib, index) => (
                <span
                  key={`${sib}-${index}`}
                  className="rounded-md border border-border/35 bg-primary/[0.06] px-2 py-0.5 text-xs text-foreground"
                >
                  {sib}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="rounded-lg border border-border/35 bg-primary/[0.04] px-4 py-3.5">
          <p className="whitespace-pre-wrap break-words text-base leading-relaxed text-foreground">
            {!revealed
              ? maskedSegments.map((seg, idx) =>
                  seg.kind === 'plain' ? (
                    <React.Fragment key={idx}>{seg.text}</React.Fragment>
                  ) : (
                    <span
                      key={idx}
                      data-testid="sprint-mindmap-masked-pill"
                      className="mx-0.5 inline-flex items-center rounded border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-sm tabular-nums text-primary"
                    >
                      {seg.text}
                    </span>
                  ),
                )
              : revealedSegments.map((seg, idx) =>
                  seg.kind === 'plain' ? (
                    <React.Fragment key={idx}>{seg.text}</React.Fragment>
                  ) : (
                    <span
                      key={idx}
                      data-testid="sprint-mindmap-revealed-span"
                      className="mx-0.5 inline-flex items-center rounded border border-primary/30 bg-primary/[0.12] px-1.5 py-0.5 font-medium text-primary"
                    >
                      {seg.text}
                    </span>
                  ),
                )}
          </p>
        </div>

        {revealed && (item.noteExcerpt || hasStructuredEvidence) ? (
          <div className="mt-4 space-y-3 border-t border-border/35 pt-3 text-xs leading-relaxed text-muted-foreground">
            {item.noteExcerpt ? (
              <div>
                <div className="mb-1 font-medium text-foreground/80">
                  {t('examSprint.player.noteExcerpt')}
                </div>
                <p className="whitespace-pre-wrap break-words">{item.noteExcerpt}</p>
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

      <SprintProvenanceBar
        anchors={anchors}
        revealed={revealed}
        primaryButtonTestId="sprint-mindmap-reveal-source"
        accentPrimary
        leadingLabel={item.sourceAnchor.label ?? item.mindmapTitle}
        onRevealAnchor={onRevealAnchor}
      />
    </div>
  );
};

export default SprintMindmapClozeStage;
