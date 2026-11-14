import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import {
  applyArtifactReply,
  ArtifactUndoStack,
  parseArtifactReply,
} from './artifactEditEngine';
import {
  peekStreamingDiagram,
  renderDiagram,
  renderDiagramSvg,
  validateDiagram,
} from './diagramEngine';
import {
  classifySvgElementAnimation,
  markShapes,
  peekSvgProgress,
  sanitizeSvg,
  sanitizeSvgFragment,
  svgTitleOf,
  type SvgProgressItem,
} from './liveSvgStream';

// ============================================================================
// Props 定义
// ============================================================================

export interface DiagramAndLiveSvgViewProps {
  /** 渲染模式：声明式 JSON 图表或原生 SVG */
  mode: 'diagram' | 'svg';
  /** 围栏内的源码内容 */
  code: string;
  /** 是否处于流式输出阶段 */
  isStreaming?: boolean;
  /** 画布配色主题 */
  theme?: 'light' | 'dark';
  /** 局部补丁或撤销生效后的源码回调 */
  onApplyPatch?: (nextCode: string) => void;
  /** 可选块标识（用于多块共享撤销栈时按块隔离） */
  blockKey?: string;
  /** 可选外部撤销栈实例 */
  undoStack?: ArtifactUndoStack;
  /** 可选显式标题 */
  title?: string;
  /** 外层附加类名 */
  className?: string;
}

interface ComputedViewState {
  phase: 'waiting' | 'drawing' | 'ok' | 'error';
  svg: string | null;
  svgRootAttrs: string;
  svgStreamItems: SvgProgressItem[];
  errorMessage: string;
  resolvedTitle: string | null;
}

// ============================================================================
// 组件实现
// ============================================================================

export const DiagramAndLiveSvgView: React.FC<DiagramAndLiveSvgViewProps> = ({
  mode,
  code,
  isStreaming = false,
  theme: themeProp,
  onApplyPatch,
  blockKey = 'default-artifact-block',
  undoStack: externalUndoStack,
  title,
  className,
}) => {
  const { t } = useTranslation('generativeUi');
  const theme: 'light' | 'dark' =
    themeProp ??
    (typeof document !== 'undefined' &&
    (document.documentElement.classList.contains('dark') ||
      document.documentElement.getAttribute('data-theme') === 'dark')
      ? 'dark'
      : 'light');
  const internalUndoStackRef = useRef<ArtifactUndoStack>(new ArtifactUndoStack());
  const undoStack = externalUndoStack ?? internalUndoStackRef.current;

  const [localCode, setLocalCode] = useState<string>(code);
  const [undoVersion, setUndoVersion] = useState<number>(0);
  const [sourceOpen, setSourceOpen] = useState<boolean>(false);
  const [editOpen, setEditOpen] = useState<boolean>(false);
  const [editInstruction, setEditInstruction] = useState<string>('');
  const [patchSearch, setPatchSearch] = useState<string>('');
  const [patchReplace, setPatchReplace] = useState<string>('');
  const [editError, setEditError] = useState<string>('');

  const prevPropCodeRef = useRef<string>(code);
  const prevStreamingRef = useRef<boolean>(isStreaming);

  useEffect(() => {
    const prevPropCode = prevPropCodeRef.current;
    const wasStreaming = prevStreamingRef.current;
    prevPropCodeRef.current = code;
    prevStreamingRef.current = isStreaming;

    if (code !== prevPropCode) {
      if (!isStreaming && !wasStreaming && code !== localCode && localCode.trim().length > 0) {
        const latest = undoStack.findLatest({ blockKey, kind: mode });
        if (!latest || latest.after !== code) {
          undoStack.push({
            blockKey,
            kind: mode,
            before: localCode,
            after: code,
          });
          setUndoVersion((v) => v + 1);
        }
      }
      setLocalCode(code);
    }
  }, [code, isStreaming, localCode, undoStack, blockKey, mode]);

  const viewState = useMemo<ComputedViewState>(() => {
    const trimmed = localCode.replace(/\s+$/, '');

    if (mode === 'diagram') {
      if (isStreaming) {
        const partialDoc = peekStreamingDiagram(trimmed);
        if (!partialDoc) {
          return {
            phase: 'waiting',
            svg: null,
            svgRootAttrs: '',
            svgStreamItems: [],
            errorMessage: '',
            resolvedTitle: title ?? null,
          };
        }
        try {
          const rendered = renderDiagram(partialDoc, { theme, tolerant: true });
          const rawSvg = renderDiagramSvg(partialDoc, { theme, tolerant: true });
          if (!rawSvg || rendered.shapes.length === 0) {
            return {
              phase: 'waiting',
              svg: null,
              svgRootAttrs: '',
              svgStreamItems: [],
              errorMessage: '',
              resolvedTitle: title ?? null,
            };
          }
          const items: SvgProgressItem[] = rendered.shapes.map((shape, idx) => {
            const safePiece = sanitizeSvgFragment(shape.svg);
            return {
              raw: shape.svg,
              svg: safePiece,
              animation: classifySvgElementAnimation(safePiece),
              order: idx,
            };
          });
          return {
            phase: 'drawing',
            svg: sanitizeSvg(rawSvg),
            svgRootAttrs: `xmlns="http://www.w3.org/2000/svg" viewBox="${rendered.viewBox}"`,
            svgStreamItems: items,
            errorMessage: '',
            resolvedTitle: title ?? null,
          };
        } catch {
          return {
            phase: 'waiting',
            svg: null,
            svgRootAttrs: '',
            svgStreamItems: [],
            errorMessage: '',
            resolvedTitle: title ?? null,
          };
        }
      }

      try {
        const parsed: unknown = JSON.parse(trimmed);
        const validated = validateDiagram(parsed);
        const rawSvg = renderDiagramSvg(validated, { theme });
        const cleanSvg = sanitizeSvg(rawSvg);
        return {
          phase: 'ok',
          svg: cleanSvg,
          svgRootAttrs: '',
          svgStreamItems: [],
          errorMessage: '',
          resolvedTitle: title ?? null,
        };
      } catch (err) {
        return {
          phase: 'error',
          svg: null,
          svgRootAttrs: '',
          svgStreamItems: [],
          errorMessage: err instanceof Error ? err.message : String(err),
          resolvedTitle: title ?? null,
        };
      }
    }

    // mode === 'svg'
    if (isStreaming) {
      try {
        const progress = peekSvgProgress(trimmed);
        if (!progress) {
          return {
            phase: 'waiting',
            svg: null,
            svgRootAttrs: '',
            svgStreamItems: [],
            errorMessage: '',
            resolvedTitle: title ?? null,
          };
        }
        const streamSvg = `<svg ${progress.rootAttrs}>${progress.items
          .map((item) => item.svg)
          .join('')}</svg>`;
        return {
          phase: 'drawing',
          svg: streamSvg,
          svgRootAttrs: progress.rootAttrs,
          svgStreamItems: progress.items,
          errorMessage: '',
          resolvedTitle: title ?? null,
        };
      } catch {
        return {
          phase: 'waiting',
          svg: null,
          svgRootAttrs: '',
          svgStreamItems: [],
          errorMessage: '',
          resolvedTitle: title ?? null,
        };
      }
    }

    try {
      const cleanSvg = sanitizeSvg(trimmed);
      const inferredTitle = title || svgTitleOf(cleanSvg);
      return {
        phase: 'ok',
        svg: cleanSvg,
        svgRootAttrs: '',
        svgStreamItems: [],
        errorMessage: '',
        resolvedTitle: inferredTitle ?? null,
      };
    } catch (err) {
      return {
        phase: 'error',
        svg: null,
        svgRootAttrs: '',
        svgStreamItems: [],
        errorMessage: err instanceof Error ? err.message : String(err),
        resolvedTitle: title ?? null,
      };
    }
  }, [localCode, mode, isStreaming, theme, title]);

  const canvasHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    if (viewState.phase === 'drawing' && viewState.svgStreamItems.length > 0) {
      host.innerHTML = `<svg ${viewState.svgRootAttrs}></svg>`;
      const svgRoot = host.querySelector('svg');
      if (!svgRoot) return;

      viewState.svgStreamItems.forEach((item) => {
        const beforeCount = svgRoot.childElementCount;
        svgRoot.insertAdjacentHTML('beforeend', item.svg);
        for (let i = beforeCount; i < svgRoot.childElementCount; i++) {
          const el = svgRoot.children[i];
          if (item.animation === 'stroke-draw' || item.animation === 'fade-in') {
            el.classList.add(item.animation);
          }
          el.setAttribute('data-animation', item.animation);
          markShapes(el, item.order);
        }
      });
      return;
    }

    if (viewState.phase === 'ok' && viewState.svg) {
      host.innerHTML = viewState.svg;
      return;
    }

    host.innerHTML = '';
  }, [viewState]);

  const canUndo = useMemo(() => {
    void undoVersion;
    return (
      undoStack.canUndo({ blockKey, kind: mode, currentSource: localCode }) ||
      undoStack.canUndo({ blockKey, kind: mode }) ||
      undoStack.canUndo({ kind: mode, currentSource: localCode })
    );
  }, [undoStack, blockKey, mode, localCode, undoVersion]);

  const commitPatchedCode = useCallback(
    (nextCode: string) => {
      undoStack.push({
        blockKey,
        kind: mode,
        before: localCode,
        after: nextCode,
      });
      setLocalCode(nextCode);
      setUndoVersion((v) => v + 1);
      setEditError('');
      setPatchSearch('');
      setPatchReplace('');
      setEditInstruction('');
      onApplyPatch?.(nextCode);
    },
    [undoStack, blockKey, mode, localCode, onApplyPatch],
  );

  const handleApplyPatch = useCallback(() => {
    setEditError('');
    try {
      if (patchSearch.length > 0) {
        const nextCode = applyArtifactReply(
          localCode,
          { edits: [{ search: patchSearch, replace: patchReplace }] },
          'patch',
        );
        commitPatchedCode(nextCode);
        return;
      }

      const rawInstruction = editInstruction.trim();
      if (!rawInstruction) {
        return;
      }

      const parsed = parseArtifactReply(rawInstruction);
      const replyObj =
        parsed && typeof parsed === 'object' && 'search' in parsed && !('edits' in parsed)
          ? { edits: [parsed] }
          : parsed;
      const modeKind =
        replyObj && typeof replyObj === 'object' && 'source' in replyObj && !('edits' in replyObj)
          ? 'rewrite'
          : 'patch';
      const nextCode = applyArtifactReply(localCode, replyObj, modeKind);
      commitPatchedCode(nextCode);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    }
  }, [patchSearch, patchReplace, editInstruction, localCode, commitPatchedCode]);

  const handleUndo = useCallback(() => {
    const rev =
      undoStack.undo({ blockKey, kind: mode, currentSource: localCode }) ??
      undoStack.undo({ blockKey, kind: mode }) ??
      undoStack.undo({ kind: mode, currentSource: localCode });
    if (!rev) return;
    setLocalCode(rev.before);
    setUndoVersion((v) => v + 1);
    setEditError('');
    onApplyPatch?.(rev.before);
  }, [undoStack, blockKey, mode, localCode, onApplyPatch]);

  return (
    <div
      className={cn(
        'diagram-live-svg-view flex w-full flex-col rounded-lg border border-border/35 bg-card/30',
        className,
      )}
      data-testid="diagram-live-svg-view"
      data-mode={mode}
      data-phase={viewState.phase}
      data-theme={theme}
    >
      {/* 顶栏 */}
      <div
        className="flex items-center justify-between gap-2 border-b border-border/35 px-3 py-1.5 text-xs"
        data-testid="diagram-svg-toolbar"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              isStreaming
                ? 'bg-amber-500/80'
                : viewState.phase === 'error'
                  ? 'bg-destructive'
                  : 'bg-emerald-500/80',
            )}
            data-testid="diagram-svg-status-dot"
            aria-hidden="true"
          />
          <span className="font-mono text-xs uppercase text-muted-foreground">
            {mode}
          </span>
          {viewState.resolvedTitle && (
            <span
              className="truncate font-medium text-foreground"
              data-testid="diagram-svg-title"
            >
              {viewState.resolvedTitle}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-40"
            data-testid="canvas-undo-button"
          >
            <span>{t('generativeUi:canvas.undoEdit', '撤销修改')}</span>
          </button>
          <button
            type="button"
            onClick={() => setEditOpen((prev) => !prev)}
            aria-expanded={editOpen}
            className={cn(
              'rounded px-2 py-0.5 text-xs transition-colors hover:bg-muted',
              editOpen ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
            )}
            data-testid="canvas-toggle-edit"
          >
            {t('generativeUi:canvas.localEdit', '局部修改')}
          </button>
          <button
            type="button"
            onClick={() => setSourceOpen((prev) => !prev)}
            aria-expanded={sourceOpen}
            className={cn(
              'rounded px-2 py-0.5 text-xs transition-colors hover:bg-muted',
              sourceOpen ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
            )}
            data-testid="canvas-toggle-source"
          >
            {t('generativeUi:canvas.source', '源码')}
          </button>
        </div>
      </div>

      {/* 图形舞台 */}
      <div className="relative w-full p-3" data-testid="diagram-svg-stage">
        {viewState.phase === 'waiting' && (
          <div
            className="flex min-h-[120px] items-center justify-center text-xs text-muted-foreground"
            data-testid="diagram-svg-waiting"
            role="status"
          >
            {t('generativeUi:chrome.streaming', '生成中…')}
          </div>
        )}

        {viewState.phase === 'error' && (
          <div
            className="rounded border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
            data-testid="diagram-svg-error"
            role="alert"
          >
            <div className="font-medium">
              {t('generativeUi:blocks.render_error', '内容渲染失败')}
            </div>
            <div className="mt-1 break-words text-muted-foreground">
              {viewState.errorMessage}
            </div>
          </div>
        )}

        <div
          ref={canvasHostRef}
          className={cn(
            'diagram-svg-canvas w-full overflow-x-auto',
            (viewState.phase === 'waiting' || viewState.phase === 'error') && 'hidden',
          )}
          data-testid="diagram-svg-canvas"
        />
      </div>

      {/* 源码切换预览 */}
      {sourceOpen && (
        <div
          className="border-t border-border/35 bg-muted/30 p-3"
          data-testid="canvas-source-view"
        >
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('generativeUi:canvas.source', '源码')}</span>
            <span className="font-mono tabular-nums">
              {t('generativeUi:canvas.charCount', {
                count: localCode.length,
                defaultValue: '{{count}} 字',
              })}
            </span>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
            <code>{localCode}</code>
          </pre>
        </div>
      )}

      {/* 就地局部修改栏 */}
      {editOpen && (
        <div
          className="flex flex-col gap-2 border-t border-border/35 bg-card/50 p-3 text-xs"
          data-testid="canvas-local-edit-bar"
        >
          <div className="flex items-center justify-between text-muted-foreground">
            <span>
              {t('generativeUi:canvas.localEditHeader', '就地局部修改（仅作用于当前画板）')}
            </span>
          </div>
          <input
            type="text"
            value={editInstruction}
            onChange={(e) => setEditInstruction(e.target.value)}
            placeholder={t(
              'generativeUi:canvas.editInstructionPlaceholder',
              '输入修改要求，或粘贴 { search, replace } JSON 补丁',
            )}
            aria-label={t('generativeUi:canvas.editInstructionAria', '修改要求')}
            data-testid="canvas-edit-instruction"
            className="w-full rounded border border-border/35 bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              type="text"
              value={patchSearch}
              onChange={(e) => setPatchSearch(e.target.value)}
              placeholder={t(
                'generativeUi:canvas.patchSearchPlaceholder',
                '查找原片段 (search)',
              )}
              aria-label={t('generativeUi:canvas.patchSearchAria', '查找片段')}
              data-testid="canvas-patch-search"
              className="w-full rounded border border-border/35 bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary"
            />
            <input
              type="text"
              value={patchReplace}
              onChange={(e) => setPatchReplace(e.target.value)}
              placeholder={t(
                'generativeUi:canvas.patchReplacePlaceholder',
                '替换为新片段 (replace)',
              )}
              aria-label={t('generativeUi:canvas.patchReplaceAria', '替换片段')}
              data-testid="canvas-patch-replace"
              className="w-full rounded border border-border/35 bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary"
            />
          </div>
          {editError && (
            <p
              className="m-0 text-xs text-destructive"
              role="alert"
              data-testid="canvas-edit-error"
            >
              {editError}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              {t('generativeUi:canvas.collapse', '收起')}
            </button>
            <button
              type="button"
              onClick={handleApplyPatch}
              data-testid="canvas-apply-patch"
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              {t('generativeUi:canvas.applyEdit', '应用修改')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DiagramAndLiveSvgView;
