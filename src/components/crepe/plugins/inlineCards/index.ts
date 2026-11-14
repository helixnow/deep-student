/**
 * Crepe inline card indicator decoration plugin (`editor:inline-cards`).
 *
 * Opt-in via `CrepePluginsOptions.inlineCards` (`defaultPluginOptions.inlineCards = false`).
 * Renders a non-editable Mineral indicator pill (`QA` / `C1`..`C12` + 6px green dot)
 * at the end of compiled blocks without mutating the ProseMirror document or Markdown.
 *
 * Strictly skips scanning/rebuilding while `view.composing === true` (CJK IME safety)
 * and refreshes cleanly after `compositionend`.
 */
import type { Node as ProseNode } from '@milkdown/prose/model';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';
import i18next from 'i18next';
import {
  compileInlineCardsFromDoc,
  type InlineCardKind,
} from './scanner';

export interface InlineCardsPluginConfig {
  /** Owning note ID (or lazy getter) used for deterministic block-scoped card IDs. */
  noteId?: string | (() => string | null | undefined);
}

interface InlineCardsMeta {
  forceRebuild?: boolean;
}

const DEFAULT_FALLBACK_NOTE_ID = 'inline-preview';

export const inlineCardsPluginKey = new PluginKey<DecorationSet>('crepeInlineCards');

function resolveNoteId(config?: InlineCardsPluginConfig | boolean): string {
  if (!config || config === true) return DEFAULT_FALLBACK_NOTE_ID;
  const raw = typeof config.noteId === 'function' ? config.noteId() : config.noteId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_FALLBACK_NOTE_ID;
}

export function createInlineCardIndicatorElement(
  kind: InlineCardKind,
  cardCount: number,
): HTMLSpanElement {
  const pill = document.createElement('span');
  pill.setAttribute('contenteditable', 'false');
  pill.setAttribute('data-testid', 'inline-card-indicator');
  pill.setAttribute('data-card-kind', kind);
  pill.className =
    'ml-2 inline-flex items-center gap-1 rounded-full border border-border/35 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground select-none align-middle';

  const typeLabel = kind === 'qa'
    ? i18next.t('notes:inlineCards.badge_qa')
    : i18next.t('notes:inlineCards.badge_cloze');
  const syncedTooltip = i18next.t('notes:inlineCards.synced_tooltip');
  pill.title = `${typeLabel} · ${syncedTooltip}`;
  pill.setAttribute('aria-label', pill.title);

  const dot = document.createElement('span');
  dot.className = 'inline-block h-1.5 w-1.5 rounded-full bg-success shrink-0';
  dot.setAttribute('aria-hidden', 'true');

  const code = document.createElement('span');
  code.className = 'font-mono tabular-nums leading-none';
  code.textContent = kind === 'qa' ? 'QA' : `C${cardCount}`;

  pill.appendChild(dot);
  pill.appendChild(code);
  return pill;
}

export function buildInlineCardDecorations(doc: ProseNode, noteId: string): DecorationSet {
  const matches = compileInlineCardsFromDoc(doc, { noteId });
  if (matches.length === 0) return DecorationSet.empty;

  const decorations = matches.map((match) =>
    Decoration.widget(
      match.widgetPos,
      () => createInlineCardIndicatorElement(match.kind, match.cardCount),
      {
        side: 1,
        key: match.key,
        ignoreSelection: true,
      },
    ),
  );
  return DecorationSet.create(doc, decorations);
}

export function createInlineCardsProsePlugin(
  config?: InlineCardsPluginConfig | boolean,
): Plugin<DecorationSet> {
  let boundView: EditorView | null = null;
  let domComposing = false;

  const isViewComposing = (): boolean => Boolean(domComposing || boundView?.composing);

  return new Plugin<DecorationSet>({
    key: inlineCardsPluginKey,
    view(editorView) {
      boundView = editorView;
      return {
        destroy() {
          if (boundView === editorView) {
            boundView = null;
          }
          domComposing = false;
        },
      };
    },
    state: {
      init: (_config, state) => buildInlineCardDecorations(state.doc, resolveNoteId(config)),
      apply: (tr, oldSet, _oldState, newState) => {
        const meta = tr.getMeta(inlineCardsPluginKey) as InlineCardsMeta | undefined;
        if (meta?.forceRebuild) {
          if (isViewComposing()) {
            return oldSet.map(tr.mapping, tr.doc);
          }
          return buildInlineCardDecorations(newState.doc, resolveNoteId(config));
        }
        if (!tr.docChanged) {
          return oldSet;
        }
        if (isViewComposing() || Boolean(tr.getMeta('composition'))) {
          return oldSet.map(tr.mapping, tr.doc);
        }
        return buildInlineCardDecorations(newState.doc, resolveNoteId(config));
      },
    },
    props: {
      decorations(state) {
        return inlineCardsPluginKey.getState(state) ?? DecorationSet.empty;
      },
      handleDOMEvents: {
        compositionstart() {
          domComposing = true;
          return false;
        },
        compositionend(view) {
          domComposing = false;
          queueMicrotask(() => {
            if (view.isDestroyed || view.composing || domComposing) return;
            const tr = view.state.tr
              .setMeta(inlineCardsPluginKey, { forceRebuild: true } satisfies InlineCardsMeta)
              .setMeta('addToHistory', false);
            view.dispatch(tr);
          });
          return false;
        },
      },
    },
  });
}

export function inlineCardsPlugin(config?: InlineCardsPluginConfig | boolean) {
  return $prose(() => createInlineCardsProsePlugin(config));
}
