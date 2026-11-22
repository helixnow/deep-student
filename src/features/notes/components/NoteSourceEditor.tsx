import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror, { ExternalChange, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { openSearchPanel } from '@codemirror/search';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { vscodeDarkInit, vscodeLightInit } from '@uiw/codemirror-theme-vscode';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import '@/styles/notes-typography.css';
import './NoteSourceEditor.css';

export interface NoteSourceEditorHandle {
  focus: () => void;
  openSearch: () => void;
}

export interface NoteSourceEditorProps {
  value: string;
  readOnly?: boolean;
  onChange: (nextMarkdown: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onExitSourceMode?: () => void;
  className?: string;
  ariaLabel?: string;
}

const detectDarkMode = (): boolean => {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.classList.contains('dark')) return true;
  if (document.documentElement.getAttribute('data-theme') === 'dark') return true;
  if (document.body?.classList.contains('dark-theme')) return true;
  return false;
};

const countLines = (text: string): number => (text.length === 0 ? 1 : text.split('\n').length);

const sharedThemeSettings = {
  background: 'transparent',
  foreground: 'var(--notes-ink, hsl(var(--foreground)))',
  caret: 'var(--notes-ink, hsl(var(--foreground)))',
  selection: 'var(--notes-selection-bg, hsl(var(--primary) / 0.18))',
  selectionMatch: 'hsl(var(--primary) / 0.12)',
  lineHighlight: 'var(--notes-surface-subtle, hsl(var(--muted) / 0.35))',
  gutterBackground: 'transparent',
  gutterForeground: 'hsl(var(--muted-foreground) / 0.5)',
  gutterActiveForeground: 'hsl(var(--foreground) / 0.82)',
  gutterBorder: 'transparent',
  fontFamily: 'var(--font-mono)',
};

const MARKDOWN_HIGHLIGHT_STYLES = [
  { tag: tags.heading, color: 'hsl(var(--primary))', fontWeight: '600' },
  { tag: tags.link, color: 'hsl(var(--info))', textDecoration: 'underline' },
  { tag: tags.url, color: 'hsl(var(--muted-foreground))' },
  { tag: [tags.meta, tags.processingInstruction], color: 'hsl(var(--muted-foreground) / 0.72)' },
  { tag: tags.quote, color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' },
  { tag: tags.strong, color: 'var(--notes-ink, hsl(var(--foreground)))', fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, color: 'hsl(var(--muted-foreground))', textDecoration: 'line-through' },
  { tag: tags.monospace, color: 'var(--notes-inline-code-color, hsl(var(--foreground) / 0.86))' },
];

const createSurfaceTheme = (dark: boolean) =>
  EditorView.theme(
    {
      '&': {
        backgroundColor: 'transparent',
        color: 'var(--notes-ink, hsl(var(--foreground)))',
        fontFamily: 'var(--font-mono)',
        fontSize: 'calc(14px * var(--font-size-scale, 1))',
        lineHeight: '1.7',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.7',
      },
      '.cm-content': {
        caretColor: 'var(--notes-ink, hsl(var(--foreground)))',
        fontFamily: 'var(--font-mono)',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--notes-ink, hsl(var(--foreground)))',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--notes-selection-bg, hsl(var(--primary) / 0.18))',
      },
      '.cm-activeLine': {
        backgroundColor: 'var(--notes-surface-subtle, hsl(var(--muted) / 0.35))',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: 'hsl(var(--muted-foreground) / 0.5)',
        border: 'none',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'hsl(var(--foreground) / 0.82)',
      },
      '.cm-foldPlaceholder': {
        backgroundColor: 'hsl(var(--muted))',
        color: 'hsl(var(--muted-foreground))',
        border: '1px solid hsl(var(--border))',
        borderRadius: '4px',
        padding: '0 4px',
      },
      '.cm-tooltip': {
        backgroundColor: 'hsl(var(--popover))',
        color: 'hsl(var(--popover-foreground))',
        border: '1px solid hsl(var(--border))',
        borderRadius: 'var(--notes-radius-popup, 12px)',
        boxShadow: 'var(--notes-popover-shadow, 0 8px 24px hsl(var(--shadow-base) / 0.14))',
      },
      '.cm-panels': {
        backgroundColor: 'hsl(var(--popover))',
        color: 'hsl(var(--popover-foreground))',
        borderColor: 'hsl(var(--border))',
      },
      '.cm-searchMatch': {
        backgroundColor: 'var(--notes-search-match-bg, hsl(var(--warning) / 0.28))',
        outline: '1px solid var(--notes-search-match-ring, hsl(var(--warning) / 0.3))',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'var(--notes-search-match-active-bg, hsl(var(--warning) / 0.5))',
      },
    },
    { dark },
  );

const LIGHT_THEME_EXTENSION = [
  vscodeLightInit({ settings: sharedThemeSettings, styles: MARKDOWN_HIGHLIGHT_STYLES }),
  createSurfaceTheme(false),
];

const DARK_THEME_EXTENSION = [
  vscodeDarkInit({ settings: sharedThemeSettings, styles: MARKDOWN_HIGHLIGHT_STYLES }),
  createSurfaceTheme(true),
];

const BASIC_SETUP = {
  lineNumbers: true,
  highlightActiveLineGutter: true,
  highlightActiveLine: true,
  foldGutter: false,
  dropCursor: true,
  allowMultipleSelections: true,
  indentOnInput: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: false,
  rectangularSelection: true,
  crosshairCursor: false,
  highlightSelectionMatches: true,
  searchKeymap: true,
  tabSize: 2,
};

const MARKDOWN_EXTENSION = markdown({ base: markdownLanguage });

export const NoteSourceEditor = forwardRef<NoteSourceEditorHandle, NoteSourceEditorProps>(
  function NoteSourceEditor(
    {
      value,
      readOnly = false,
      onChange,
      onFocus,
      onBlur,
      onExitSourceMode,
      className,
      ariaLabel,
    },
    ref,
  ) {
    const { t } = useTranslation(['notes', 'common']);
    const [isDarkMode, setIsDarkMode] = useState<boolean>(() => detectDarkMode());
    const [lineCount, setLineCount] = useState<number>(() => countLines(value));

    const cmRef = useRef<ReactCodeMirrorRef | null>(null);
    const onChangeRef = useRef(onChange);
    const onFocusRef = useRef(onFocus);
    const onBlurRef = useRef(onBlur);
    const readOnlyRef = useRef(readOnly);
    const lastEmittedOrSyncedRef = useRef(value);

    onChangeRef.current = onChange;
    onFocusRef.current = onFocus;
    onBlurRef.current = onBlur;
    readOnlyRef.current = readOnly;

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          cmRef.current?.view?.focus();
        },
        openSearch: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.focus();
          openSearchPanel(view);
        },
      }),
      [],
    );

    // Keep local mirror and line count aligned with external prop syncs without emitting onChange
    useEffect(() => {
      lastEmittedOrSyncedRef.current = value;
      setLineCount(countLines(value));
    }, [value]);

    useLayoutEffect(() => {
      setIsDarkMode(detectDarkMode());
    }, []);

    useEffect(() => {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
      const syncTheme = () => setIsDarkMode(detectDarkMode());
      const observer = new MutationObserver(syncTheme);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
      });
      if (document.body) {
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ['class'],
        });
      }
      return () => observer.disconnect();
    }, []);

    const resolvedAriaLabel = ariaLabel ?? t('notes:sourceMode.aria_label', 'Markdown 源码编辑器');

    const extensions = useMemo(() => {
      const contentAttrs: Record<string, string> = {
        'aria-label': resolvedAriaLabel,
      };
      if (readOnly) {
        contentAttrs['aria-readonly'] = 'true';
      }
      return [
        MARKDOWN_EXTENSION,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of(contentAttrs),
        EditorView.domEventHandlers({
          focus: () => {
            onFocusRef.current?.();
            return false;
          },
          blur: () => {
            onBlurRef.current?.();
            return false;
          },
        }),
      ];
    }, [resolvedAriaLabel, readOnly]);

    const handleChange = useCallback((nextValue: string, viewUpdate: ViewUpdate) => {
      setLineCount(viewUpdate.state.doc.lines);
      if (readOnlyRef.current) return;
      if (viewUpdate.transactions.some((tr) => tr.annotation(ExternalChange))) {
        lastEmittedOrSyncedRef.current = nextValue;
        return;
      }
      if (nextValue === lastEmittedOrSyncedRef.current) return;
      lastEmittedOrSyncedRef.current = nextValue;
      onChangeRef.current(nextValue);
    }, []);

    const badgeLabel = t('notes:sourceMode.badge', 'Markdown 源码');
    const lineCountLabel = t('notes:sourceMode.line_count', {
      defaultValue: '{{count}} 行',
      count: lineCount,
    });
    const exitLabel = t('notes:sourceMode.exit', '返回可视化编辑');

    return (
      <div
        className={cn('notes-source-editor', className)}
        data-readonly={readOnly ? 'true' : undefined}
        data-theme-mode={isDarkMode ? 'dark' : 'light'}
      >
        <div className="notes-source-editor-bar">
          <span className="notes-source-editor-badge">
            <span className="notes-source-editor-badge-dot" aria-hidden="true" />
            <span>{badgeLabel}</span>
          </span>
          <span className="notes-source-editor-meta">
            {readOnly && (
              <span className="notes-source-editor-readonly-pill">
                {t('notes:sourceMode.readonly', '只读')}
              </span>
            )}
            <span data-testid="notes-source-line-count">{lineCountLabel}</span>
            {onExitSourceMode && (
              <DsButton
                variant="ghost"
                size="sm"
                className="notes-source-editor-exit-btn"
                onClick={onExitSourceMode}
              >
                {exitLabel}
              </DsButton>
            )}
          </span>
        </div>
        <div className="notes-source-editor-body">
          <CodeMirror
            ref={cmRef}
            value={value}
            theme={isDarkMode ? DARK_THEME_EXTENSION : LIGHT_THEME_EXTENSION}
            extensions={extensions}
            basicSetup={BASIC_SETUP}
            editable={!readOnly}
            readOnly={readOnly}
            onChange={handleChange}
            height="auto"
          />
        </div>
      </div>
    );
  },
);

export default NoteSourceEditor;
