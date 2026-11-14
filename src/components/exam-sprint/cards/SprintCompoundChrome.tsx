import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOut, ArrowUUpLeft, CaretRight } from '@phosphor-icons/react';
import { renderCardFaceLatexHtml } from '@/components/anki/utils/cardFaceLatex';
import { cn } from '@/utils/cn';
import type { NormalizedCompoundExcerpt } from '../compoundCardModel';
import { formatProvenancePillLabel } from '../sourceAnchorBridge';
import {
  getSourceKindDotClass,
  type ResolvedSprintSourceAnchor,
  type SemanticAnchorKind,
} from '../sprintContracts';

export const SprintMathOrPlainText: React.FC<{
  text: string;
  className?: string;
}> = ({ text, className }) => {
  const latexHtml = useMemo(() => renderCardFaceLatexHtml(text), [text]);
  if (latexHtml) {
    return (
      <div
        className={cn('prose prose-sm dark:prose-invert max-w-none break-words', className)}
        dangerouslySetInnerHTML={{ __html: latexHtml }}
      />
    );
  }
  return (
    <div className={cn('whitespace-pre-wrap break-words leading-relaxed text-foreground', className)}>
      {text}
    </div>
  );
};

export interface SprintBreadcrumbHeaderProps {
  originKind: SemanticAnchorKind;
  crumbs: readonly string[];
  anchorCount: number;
  trailingMeta?: string | null;
  navTestId?: string;
  ariaLabel?: string;
}

export const SprintBreadcrumbHeader: React.FC<SprintBreadcrumbHeaderProps> = ({
  originKind,
  crumbs,
  anchorCount,
  trailingMeta = null,
  navTestId,
  ariaLabel,
}) => {
  const { t } = useTranslation('review');
  const originLabel = t(`examSprint.player.sourceKind.${originKind}`);

  return (
    <div
      data-testid="sprint-card-breadcrumb"
      data-origin-kind={originKind}
      className="mb-3.5 flex flex-wrap items-center justify-between gap-2 border-b border-border/35 pb-3 text-xs text-muted-foreground"
    >
      <nav
        aria-label={ariaLabel ?? originLabel}
        data-testid={navTestId}
        className="flex min-w-0 flex-wrap items-center gap-1.5"
      >
        <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-foreground/85">
          <span
            data-testid="sprint-breadcrumb-dot"
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', getSourceKindDotClass(originKind))}
            aria-hidden="true"
          />
          <span>{originLabel}</span>
        </span>

        {crumbs.map((crumb, index) => (
          <React.Fragment key={`${crumb}-${index}`}>
            <CaretRight size={11} className="shrink-0 text-muted-foreground/60" aria-hidden="true" />
            <span className="max-w-[220px] truncate text-muted-foreground">{crumb}</span>
          </React.Fragment>
        ))}
      </nav>

      {anchorCount > 1 ? (
        <span
          data-testid="sprint-breadcrumb-source-count"
          className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
        >
          {t('examSprint.player.provenance.multiCount', { count: anchorCount })}
        </span>
      ) : trailingMeta ? (
        <span className="max-w-[200px] truncate font-mono text-[11px] tabular-nums text-muted-foreground">
          {trailingMeta}
        </span>
      ) : null}
    </div>
  );
};

export interface SprintCompoundEvidenceBlocksProps {
  personalNote?: string | null;
  excerpts: readonly NormalizedCompoundExcerpt[];
  childBullets: readonly string[];
  onRevealAnchor?: (anchor: ResolvedSprintSourceAnchor) => void;
}

export const SprintCompoundEvidenceBlocks: React.FC<SprintCompoundEvidenceBlocksProps> = ({
  personalNote,
  excerpts,
  childBullets,
  onRevealAnchor,
}) => {
  const { t } = useTranslation('review');

  if (!personalNote && excerpts.length === 0 && childBullets.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3.5" data-testid="sprint-compound-back-evidence">
      {personalNote ? (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('examSprint.player.personalNote')}
          </div>
          <SprintMathOrPlainText text={personalNote} className="text-sm" />
        </div>
      ) : null}

      {excerpts.length > 0 ? (
        <div className="space-y-2" data-testid="sprint-compound-excerpts">
          <div className="text-xs font-medium text-muted-foreground">
            {t('examSprint.player.evidenceExcerpts')}
          </div>
          <div className="flex flex-col gap-2">
            {excerpts.map((excerpt) => {
              const pillLabel = excerpt.anchor
                ? formatProvenancePillLabel(excerpt.anchor, t)
                : null;

              if (excerpt.imageSrc) {
                return (
                  <div
                    key={excerpt.id}
                    data-testid="sprint-excerpt-block"
                    data-excerpt-kind="image"
                    className="space-y-2 rounded-lg border border-border/35 bg-muted/20 p-2.5"
                  >
                    <div className="overflow-hidden rounded border border-border/35 bg-background/60">
                      <img
                        src={excerpt.imageSrc}
                        alt={excerpt.text ?? excerpt.sourceLabel ?? excerpt.id}
                        data-testid="sprint-excerpt-image"
                        className="block max-h-56 w-full object-contain"
                      />
                    </div>
                    {excerpt.text || excerpt.latex || pillLabel ? (
                      <div className="flex items-start justify-between gap-2 px-0.5 text-xs">
                        <div className="min-w-0 flex-1 space-y-1">
                          {excerpt.text ? (
                            <SprintMathOrPlainText
                              text={excerpt.text}
                              className="text-xs text-muted-foreground"
                            />
                          ) : null}
                          {excerpt.latex ? (
                            <SprintMathOrPlainText
                              text={`$$${excerpt.latex}$$`}
                              className="text-xs"
                            />
                          ) : null}
                        </div>
                        {excerpt.anchor && pillLabel && onRevealAnchor ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onRevealAnchor(excerpt.anchor!);
                            }}
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-border/35 bg-card px-2 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                          >
                            <span
                              className={cn(
                                'h-1.5 w-1.5 shrink-0 rounded-full',
                                getSourceKindDotClass(excerpt.anchor.kind),
                              )}
                              aria-hidden="true"
                            />
                            <span>{pillLabel}</span>
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              }

              return (
                <div
                  key={excerpt.id}
                  data-testid="sprint-excerpt-block"
                  data-excerpt-kind={excerpt.kind}
                  className="flex items-start justify-between gap-2.5 rounded-lg border border-border/35 border-l-2 border-l-primary/50 bg-muted/20 px-3.5 py-2.5"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    {excerpt.text ? (
                      <SprintMathOrPlainText
                        text={excerpt.text}
                        className="text-xs text-foreground/90"
                      />
                    ) : null}
                    {excerpt.latex ? (
                      <SprintMathOrPlainText text={`$$${excerpt.latex}$$`} className="text-xs" />
                    ) : null}
                  </div>

                  {excerpt.anchor && pillLabel && onRevealAnchor ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRevealAnchor(excerpt.anchor!);
                      }}
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-border/35 bg-card px-2 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          getSourceKindDotClass(excerpt.anchor.kind),
                        )}
                        aria-hidden="true"
                      />
                      <span>{pillLabel}</span>
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {childBullets.length > 0 ? (
        <div className="space-y-1.5" data-testid="sprint-compound-bullets">
          <div className="text-xs font-medium text-muted-foreground">
            {t('examSprint.player.childSummaries')}
          </div>
          <ul className="space-y-1.5">
            {childBullets.map((bullet, idx) => (
              <li
                key={`${idx}-${bullet.slice(0, 24)}`}
                data-testid="sprint-child-bullet"
                className="flex items-start gap-2 text-sm text-foreground"
              >
                <span
                  className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <SprintMathOrPlainText text={bullet} className="text-sm" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

export interface SprintProvenanceBarProps {
  anchors: readonly ResolvedSprintSourceAnchor[];
  revealed: boolean;
  primaryButtonTestId: string;
  accentPrimary?: boolean;
  leadingLabel?: string | null;
  onRevealAnchor: (anchor: ResolvedSprintSourceAnchor) => void;
}

export const SprintProvenanceBar: React.FC<SprintProvenanceBarProps> = ({
  anchors,
  revealed,
  primaryButtonTestId,
  accentPrimary = false,
  leadingLabel = null,
  onRevealAnchor,
}) => {
  const { t } = useTranslation('review');

  if (anchors.length === 0) return null;

  if (anchors.length > 1) {
    return (
      <div
        data-testid="sprint-provenance-bar"
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/35 bg-card/70 px-3.5 py-2"
      >
        <span className="text-xs font-medium text-muted-foreground">
          {t('examSprint.player.provenance.label')}
        </span>

        <div className="flex flex-wrap items-center gap-1.5">
          {anchors.map((anchor, index) => {
            const pillLabel = formatProvenancePillLabel(anchor, t);
            const isPrimary = index === 0;
            return (
              <React.Fragment key={anchor.canonicalUri}>
                {index > 0 ? (
                  <span className="select-none text-xs text-muted-foreground/60" aria-hidden="true">
                    ·
                  </span>
                ) : null}
                <button
                  type="button"
                  data-testid={isPrimary ? primaryButtonTestId : `sprint-provenance-pill-${index}`}
                  data-provenance-index={index}
                  data-anchor-uri={anchor.canonicalUri}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRevealAnchor(anchor);
                  }}
                  className={cn(
                    'inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-xs tabular-nums transition-colors active:scale-95 active:opacity-80',
                    isPrimary
                      ? 'border-primary/35 bg-primary/[0.08] font-medium text-primary hover:bg-primary/[0.14]'
                      : 'border-border/35 bg-card text-foreground hover:border-border/60 hover:bg-muted/60',
                  )}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      getSourceKindDotClass(anchor.kind),
                    )}
                    aria-hidden="true"
                  />
                  <span>{pillLabel}</span>
                  {isPrimary ? (
                    <kbd className="ml-0.5 rounded border border-primary/25 bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                      O
                    </kbd>
                  ) : null}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    );
  }

  if (!revealed) return null;

  const singleAnchor = anchors[0]!;
  const singlePill =
    singleAnchor.kind === 'pdf' && singleAnchor.page !== null && singleAnchor.page >= 1
      ? `P.${singleAnchor.page}`
      : singleAnchor.kind === 'media' && singleAnchor.startMs !== null && singleAnchor.startMs >= 0
        ? formatProvenancePillLabel(singleAnchor, t)
        : null;

  return (
    <div
      data-testid="sprint-provenance-bar"
      className={cn(
        'flex items-center gap-2',
        leadingLabel ? 'justify-between' : 'justify-end',
      )}
    >
      {leadingLabel ? (
        <span className="truncate text-xs text-muted-foreground">{leadingLabel}</span>
      ) : null}

      <button
        type="button"
        data-testid={primaryButtonTestId}
        data-provenance-index={0}
        data-anchor-uri={singleAnchor.canonicalUri}
        onClick={(event) => {
          event.stopPropagation();
          onRevealAnchor(singleAnchor);
        }}
        className={cn(
          'inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors active:scale-95 active:opacity-80',
          accentPrimary
            ? 'border-primary/30 bg-primary/[0.08] text-primary hover:bg-primary/[0.14]'
            : 'border-border/35 bg-card/70 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        {accentPrimary ? (
          <ArrowUUpLeft size={14} weight="bold" aria-hidden="true" />
        ) : (
          <ArrowSquareOut size={14} aria-hidden="true" />
        )}
        <span>{t('examSprint.player.revealSource')}</span>
        {singlePill ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{singlePill}</span>
          </>
        ) : null}
        <kbd
          className={cn(
            'ml-1 rounded border px-1.5 py-0.5 font-mono text-[10px]',
            accentPrimary
              ? 'border-primary/25 bg-background/60 text-primary'
              : 'border-border/35 bg-muted/50 text-muted-foreground',
          )}
        >
          O
        </kbd>
      </button>
    </div>
  );
};
