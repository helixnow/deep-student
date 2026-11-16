import type { ComponentType } from 'react';

/**
 * App-surface slots for community plugins (B7): PDF selection toolbar, chat composer slash commands, chat message
 * actions, review card actions, status bar items, desktop widgets and theme variants.
 *
 * Each slot is declared by the official UI plugin that renders it; the value types below are the public contract
 * (re-exported from `@deepstudent/ui`). Labels are already translated (use `ctx.ui.i18n`), like editor toolbar items.
 *
 * Callbacks (`run`) are called by the host with a fresh context object. A community callback that throws or returns a
 * rejected promise is reported against the plugin's error budget (enough failures unload it); the host surface keeps
 * working. Contributed components render inside the plugin's scope (`useT`, `usePluginStorage` work) and their own
 * error boundary, like every `<SlotOutlet>` entry.
 *
 * | slot                     | owner (official UI plugin) |
 * | ------------------------ | -------------------------- |
 * | `pdf.selectionToolbar`   | `dstu.ui.learning-hub`     |
 * | `chat.composer.commands` | `dstu.ui.chat`             |
 * | `chat.message.actions`   | `dstu.ui.chat`             |
 * | `review.cardActions`     | `dstu.ui.anki`             |
 * | `statusbar.items`        | `dstu.ui.workbench`        |
 * | `desktop.widgets`        | `dstu.ui.workbench`        |
 * | `theme.variants`         | `dstu.ui.settings`         |
 */

/** Icon of a contributed button: a component rendered at `size` px, e.g. a `@phosphor-icons/react` icon. */
export type SurfaceIcon = ComponentType<{ size?: number }>;

/** What a contributed callback may return; a rejection counts against the plugin's error budget. */
export type SurfaceActionResult = void | Promise<void>;

// ------------------------------------------------------------------ pdf.selectionToolbar

/** Which reader the selection comes from. The PDF, EPUB and rich document readers share the selection toolbar. */
export type ReaderSelectionKind = 'pdf' | 'epub' | 'document' | (string & {});

/** The selection a `pdf.selectionToolbar` button was clicked on; read at click time. */
export interface PdfSelectionContext {
  /** The selected text (PDF text is normalised: hyphenation across lines removed, whitespace collapsed). */
  text: string;
  /** Text right before / after the selection (may be empty). */
  contextBefore: string;
  contextAfter: string;
  /** 1-based page number, when the selection lies on a PDF page. */
  page?: number;
  /** Library resource id of the document (e.g. `tb_…`, `file_…`); absent for files that are not in the library. */
  resourceId?: string;
  /** Human-readable document title (file name). */
  documentTitle?: string;
  kind: ReaderSelectionKind;
}

/**
 * `pdf.selectionToolbar` value: a button appended to the reader's selection toolbar (after the built-in actions).
 * The toolbar collapses after the button runs.
 *
 * ```ts
 * ctx.ui.contribute('pdf.selectionToolbar', { id: 'define', value: {
 *   label: t('define'), icon: BookOpen, run: ({ text, page }) => lookUp(text, page),
 * } });
 * ```
 */
export interface PdfSelectionToolbarContribution {
  /**
   * Button text, tooltip and accessible name. Desktop shows icon + label; touch layouts show only the icon (or the
   * label when there is no icon). Keep it short (2–4 CJK characters or 1–2 words).
   */
  label: string;
  icon?: SurfaceIcon;
  /** Shown for these reader kinds only; omitted = every reader. */
  kinds?: readonly ReaderSelectionKind[];
  run(selection: PdfSelectionContext): SurfaceActionResult;
}

// ------------------------------------------------------------------ chat.composer.commands

/** Context of a chosen `/command`. The `/name` token the user typed has already been removed from the input. */
export interface ChatComposerCommandContext {
  /** The input text when the command was chosen, without the `/name` token. */
  readonly input: string;
  /** Current chat session id, if any. */
  readonly sessionId?: string;
  /** The live input text (reflects `setInput` / `insertText` calls). */
  getInput(): string;
  /** Replaces the whole input text. */
  setInput(text: string): void;
  /** Inserts text at the caret (where the `/name` token was). */
  insertText(text: string): void;
  /**
   * Sends the message, with `text` as the new input if given. The send goes through the normal send button path
   * (attachments, model, send guards apply), on the next render after the input update.
   */
  send(text?: string): void;
}

/**
 * `chat.composer.commands` value: a slash command listed when the user types `/` at the start of the chat input,
 * next to the skill commands. Choosing it removes the typed `/name` token and calls `run`.
 *
 * ```ts
 * ctx.ui.contribute('chat.composer.commands', { id: 'pomodoro-summary', value: {
 *   name: 'today', label: t('today'), description: t('today_desc'),
 *   run: (c) => c.send(`Summarise what I studied today: ${c.input}`),
 * } });
 * ```
 */
export interface ChatComposerCommandContribution {
  /** The token after `/` (`[A-Za-z0-9][A-Za-z0-9_-]*`), matched case-insensitively while the user types. */
  name: string;
  label: string;
  description?: string;
  icon?: SurfaceIcon;
  run(composer: ChatComposerCommandContext): SurfaceActionResult;
}

// ------------------------------------------------------------------ chat.message.actions

export type ChatMessageRole = 'user' | 'assistant';

/** The message a `chat.message.actions` item was clicked on. */
export interface ChatMessageActionContext {
  messageId: string;
  role: ChatMessageRole;
  /** Chat session id. */
  sessionId?: string;
  /** Message content as Markdown (what the built-in Copy action copies). */
  content: string;
}

/**
 * `chat.message.actions` value: an item in a chat message's "more" menu (desktop and mobile).
 *
 * ```ts
 * ctx.ui.contribute('chat.message.actions', { id: 'to-anki', value: {
 *   label: t('make_card'), icon: Cards, roles: ['assistant'], run: ({ content }) => makeCard(content),
 * } });
 * ```
 */
export interface ChatMessageActionContribution {
  label: string;
  icon?: SurfaceIcon;
  /** Messages this item appears on; omitted = both. */
  roles?: readonly ChatMessageRole[];
  run(message: ChatMessageActionContext): SurfaceActionResult;
}

// ------------------------------------------------------------------ review.cardActions

/** The card currently shown on the flashcard review screen. */
export interface ReviewCardContext {
  /** FSRS card state id (the review queue's card id). */
  cardId: string;
  /** Content-side card id (`anki_cards.id`), when known. */
  noteCardId?: string;
  /** Front / back field text as stored (may contain HTML; cloze cards keep their `{{c1::…}}` markup in `front`). */
  front: string;
  back: string;
  tags: readonly string[];
  /** Whether the back side is showing. */
  flipped: boolean;
}

/**
 * `review.cardActions` value: an icon button in the review screen's card toolbar (and an item in the mobile "more" menu).
 *
 * ```ts
 * ctx.ui.contribute('review.cardActions', { id: 'speak', value: {
 *   label: t('read_aloud'), icon: SpeakerHigh, run: ({ front }) => speak(front),
 * } });
 * ```
 */
export interface ReviewCardActionContribution {
  label: string;
  icon?: SurfaceIcon;
  run(card: ReviewCardContext): SurfaceActionResult;
}

// ------------------------------------------------------------------ statusbar.items

/** Props given to a status bar item. */
export interface StatusBarItemProps {
  /** Class names of the built-in status items (`wb-menubar-item`): put them on your root button for the native look. */
  className: string;
}

/**
 * `statusbar.items` value: a small item at the right end of the workbench desktop's top status bar (menu bar), after
 * the built-in learning signals. Desktop (workbench) only. Keep it narrow: an icon and a short value.
 *
 * ```ts
 * ctx.ui.contribute('statusbar.items', { id: 'streak', value: {
 *   component: ({ className }) => <button className={className} title="Streak">🔥 7</button>,
 * } });
 * ```
 */
export interface StatusBarItemContribution {
  component: ComponentType<StatusBarItemProps>;
}

// ------------------------------------------------------------------ desktop.widgets

/** Height hint of a desktop widget: `sm` ≈ 160 px, `md` ≈ 280 px, `lg` ≈ 420 px; width is the widget column's. */
export type DesktopWidgetSize = 'sm' | 'md' | 'lg';

export interface DesktopWidgetProps {
  size: DesktopWidgetSize;
}

/**
 * `desktop.widgets` value: a card in the workbench desktop's widget column (top right, below the built-in agenda and
 * briefing widgets). The host draws the glass card frame; the component fills it and may scroll inside. Hidden with
 * the other widgets when the user turns desktop widgets off, and on narrow desktops.
 *
 * ```ts
 * ctx.ui.contribute('desktop.widgets', { id: 'quote', value: {
 *   title: t('quote_of_the_day'), size: 'sm', component: QuoteWidget,
 * } });
 * ```
 */
export interface DesktopWidgetContribution {
  /** Accessible name of the widget card. */
  title: string;
  /** Omitted = `md`. */
  size?: DesktopWidgetSize;
  component: ComponentType<DesktopWidgetProps>;
}

// ------------------------------------------------------------------ theme.variants

/** CSS custom properties to set on `<html>`, e.g. `{ '--primary': '262 83% 58%' }`. Names must start with `--`. */
export type ThemeVariables = Readonly<Record<string, string>>;

/**
 * `theme.variants` value: a set of CSS variable overrides the user can pick under Settings → Appearance. The picked
 * variant's `light` or `dark` set (following the current color mode) is written to `document.documentElement.style`;
 * switching variants, picking "Default" or unloading the plugin removes it again. The choice is remembered by
 * `<plugin id>/<contribution id>`, so it comes back when the plugin is installed again.
 *
 * ```ts
 * ctx.ui.contribute('theme.variants', { id: 'sepia', value: {
 *   label: t('sepia'),
 *   light: { '--background': '40 40% 94%', '--foreground': '30 20% 20%' },
 *   dark: { '--background': '30 15% 12%' },
 * } });
 * ```
 */
export interface ThemeVariantContribution {
  label: string;
  description?: string;
  /** Applied in light mode. */
  light?: ThemeVariables;
  /** Applied in dark mode. */
  dark?: ThemeVariables;
}

declare module '../slot-map' {
  interface SlotMap {
    'pdf.selectionToolbar': PdfSelectionToolbarContribution;
    'chat.composer.commands': ChatComposerCommandContribution;
    'chat.message.actions': ChatMessageActionContribution;
    'review.cardActions': ReviewCardActionContribution;
    'statusbar.items': StatusBarItemContribution;
    'desktop.widgets': DesktopWidgetContribution;
    'theme.variants': ThemeVariantContribution;
  }
}
