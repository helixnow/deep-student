// ============================================================================
// OpenChamber Composer Enhancements
// 1. LargeTextPasteController (ask / attach / inline-double-paste + typeThrough)
// 2. preemptFloatingBlockingRequestsOnSend & syncFloatingPanelClearanceCssVar
// 3. DoubleEscapeStopGuard (600ms double-Esc anti-misfire stop guard)
// 4. SessionDraftLruStore (50-entry triplet LRU draft store with @mention state)
// ============================================================================

export const LARGE_TEXT_PASTE_CHAR_THRESHOLD = 2000;
export const LARGE_TEXT_PASTE_LINE_THRESHOLD = 25;
export const DOUBLE_PASTE_WINDOW_MS = 1000;
export const DOUBLE_ESCAPE_WINDOW_MS = 600;
export const MAX_DRAFT_ENTRIES = 50;
export const FLOATING_PANEL_CLEARANCE_CSS_VAR = '--chat-floating-panel-clearance';
export const DEFAULT_SESSION_DRAFT_LRU_STORAGE_KEY = 'dstu.chatv2.composerDrafts.lru.v2';

// ============================================================================
// 1. Large Text Paste Controller & Virtual File Helpers
// ============================================================================

export type LargeTextPasteMode = 'ask' | 'attach' | 'inline-double-paste';

export interface LargeTextPasteThresholdOptions {
  charThreshold?: number;
  lineThreshold?: number;
}

export interface VirtualPastedTextFile {
  fileName: string;
  mimeType: 'text/plain';
  content: string;
  chipToken: string;
  file?: File;
}

export interface PendingLargeTextPaste {
  offerId: number;
  content: string;
  startOffset: number;
  endOffset: number;
  timestampMs: number;
}

export interface InlineDoublePasteRecord {
  text: string;
  startOffset: number;
  endOffset: number;
  timestampMs: number;
}

export interface LargeTextPasteResult {
  action: 'inline' | 'pending-ask' | 'attach' | 'type-through' | 'double-paste-attach' | 'noop';
  intercepted: boolean;
  text: string;
  cursorOffset: number;
  attachment: VirtualPastedTextFile | null;
  pendingPaste: PendingLargeTextPaste | null;
  inlinePasteRecord: InlineDoublePasteRecord | null;
  replacedRange: { startOffset: number; endOffset: number } | null;
  suppressFileMentionPopupOnPaste: boolean;
  offerId: number | null;
}

export interface LargeTextPasteControllerOptions {
  mode?: LargeTextPasteMode;
  initialText?: string;
  initialCursorOffset?: number;
  doublePasteWindowMs?: number;
  charThreshold?: number;
  lineThreshold?: number;
  existingFileNames?: readonly string[];
  now?: () => number;
}

export interface HandlePasteContext {
  documentText?: string;
  cursorOffset?: number;
  selectionEndOffset?: number;
  timestampMs?: number;
  mode?: LargeTextPasteMode;
}

/**
 * Threshold detector for large plain-text paste.
 * Returns true when `text.length >= 2000` or line count `>= 25`.
 * Empty or whitespace-only text never triggers large-paste interception.
 */
export function isLargePlainTextPaste(
  text: string,
  options?: LargeTextPasteThresholdOptions,
): boolean {
  if (!text || text.trim().length === 0) {
    return false;
  }

  const charThreshold = options?.charThreshold ?? LARGE_TEXT_PASTE_CHAR_THRESHOLD;
  const lineThreshold = options?.lineThreshold ?? LARGE_TEXT_PASTE_LINE_THRESHOLD;

  if (text.length >= charThreshold) {
    return true;
  }

  return text.split(/\r\n|\r|\n/).length >= lineThreshold;
}

/**
 * Generates the next unused `pasted-context-N.txt` filename.
 */
export function nextPastedContextFileName(existingFileNames: readonly string[] = []): string {
  const used = new Set(existingFileNames.map((name) => name.trim().toLowerCase()));
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = `pasted-context-${index}.txt`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return `pasted-context-${Date.now()}.txt`;
}

/**
 * Builds a virtual `.txt` attachment descriptor and in-memory `File` (when supported).
 */
export function createVirtualPastedTextFile(
  content: string,
  indexOrExistingNames: number | readonly string[] = 1,
): VirtualPastedTextFile {
  const fileName =
    typeof indexOrExistingNames === 'number'
      ? `pasted-context-${Math.max(1, Math.floor(indexOrExistingNames))}.txt`
      : nextPastedContextFileName(indexOrExistingNames);
  const chipToken = `[${fileName}]`;
  const virtualFile: VirtualPastedTextFile = {
    fileName,
    mimeType: 'text/plain',
    content,
    chipToken,
  };

  if (typeof File !== 'undefined') {
    try {
      virtualFile.file = new File([content], fileName, {
        type: 'text/plain',
        lastModified: Date.now(),
      });
    } catch {
      // Non-DOM environments without File constructor support still receive metadata.
    }
  }

  return virtualFile;
}

export class LargeTextPasteController {
  private mode: LargeTextPasteMode;
  private documentText: string;
  private cursorOffset: number;
  private selectionEndOffset: number;
  private readonly doublePasteWindowMs: number;
  private readonly charThreshold: number;
  private readonly lineThreshold: number;
  private readonly now: () => number;
  private pendingPaste: PendingLargeTextPaste | null = null;
  private lastInlinePaste: InlineDoublePasteRecord | null = null;
  private attachments: VirtualPastedTextFile[] = [];
  private reservedFileNames: Set<string>;
  private offerCounter = 0;

  constructor(options?: LargeTextPasteControllerOptions) {
    this.mode = options?.mode ?? 'ask';
    this.documentText = options?.initialText ?? '';
    const initialCursor = options?.initialCursorOffset ?? this.documentText.length;
    this.cursorOffset = initialCursor;
    this.selectionEndOffset = initialCursor;
    this.doublePasteWindowMs = options?.doublePasteWindowMs ?? DOUBLE_PASTE_WINDOW_MS;
    this.charThreshold = options?.charThreshold ?? LARGE_TEXT_PASTE_CHAR_THRESHOLD;
    this.lineThreshold = options?.lineThreshold ?? LARGE_TEXT_PASTE_LINE_THRESHOLD;
    this.now = options?.now ?? (() => Date.now());
    this.reservedFileNames = new Set(
      (options?.existingFileNames ?? []).map((name) => name.trim().toLowerCase()),
    );
  }

  getMode(): LargeTextPasteMode {
    return this.mode;
  }

  setMode(mode: LargeTextPasteMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.invalidate();
    }
  }

  getDocumentText(): string {
    return this.documentText;
  }

  getCursorOffset(): number {
    return this.cursorOffset;
  }

  setDocumentState(text: string, cursorOffset = text.length, selectionEndOffset = cursorOffset): void {
    if (text !== this.documentText) this.invalidate();
    this.documentText = text;
    this.cursorOffset = Math.max(0, Math.min(cursorOffset, text.length));
    this.selectionEndOffset = Math.max(this.cursorOffset, Math.min(selectionEndOffset, text.length));
    if (
      this.lastInlinePaste &&
      (this.cursorOffset !== this.lastInlinePaste.endOffset ||
        this.selectionEndOffset !== this.lastInlinePaste.endOffset)
    ) {
      this.lastInlinePaste = null;
    }
  }

  setCursorOffset(cursorOffset: number, selectionEndOffset = cursorOffset): void {
    this.setDocumentState(this.documentText, cursorOffset, selectionEndOffset);
  }

  getPendingPaste(): PendingLargeTextPaste | null {
    return this.pendingPaste ? { ...this.pendingPaste } : null;
  }

  hasPendingPaste(): boolean {
    return this.pendingPaste !== null;
  }

  getLastInlinePasteRecord(): InlineDoublePasteRecord | null {
    return this.lastInlinePaste ? { ...this.lastInlinePaste } : null;
  }

  getAttachments(): VirtualPastedTextFile[] {
    return [...this.attachments];
  }

  invalidate(): void {
    this.pendingPaste = null;
    this.lastInlinePaste = null;
  }

  private allocateVirtualAttachment(content: string): VirtualPastedTextFile {
    const existing = [
      ...this.reservedFileNames,
      ...this.attachments.map((item) => item.fileName),
    ];
    const attachment = createVirtualPastedTextFile(content, existing);
    this.reservedFileNames.add(attachment.fileName.toLowerCase());
    this.attachments.push(attachment);
    return attachment;
  }

  private replaceRangeInDocument(start: number, end: number, replacement: string): void {
    const safeStart = Math.max(0, Math.min(start, this.documentText.length));
    const safeEnd = Math.max(safeStart, Math.min(end, this.documentText.length));
    this.documentText =
      this.documentText.slice(0, safeStart) +
      replacement +
      this.documentText.slice(safeEnd);
    const nextCursor = safeStart + replacement.length;
    this.cursorOffset = nextCursor;
    this.selectionEndOffset = nextCursor;
  }

  handlePaste(pastedText: string, context?: HandlePasteContext): LargeTextPasteResult {
    if (context?.documentText !== undefined) {
      this.documentText = context.documentText;
    }
    const startOffset =
      context?.cursorOffset !== undefined
        ? Math.max(0, Math.min(context.cursorOffset, this.documentText.length))
        : this.cursorOffset;
    const endOffset =
      context?.selectionEndOffset !== undefined
        ? Math.max(startOffset, Math.min(context.selectionEndOffset, this.documentText.length))
        : Math.max(startOffset, Math.min(this.selectionEndOffset, this.documentText.length));

    this.cursorOffset = startOffset;
    this.selectionEndOffset = endOffset;

    const effectiveMode = context?.mode ?? this.mode;
    const nowMs = context?.timestampMs ?? this.now();
    const suppressMention = shouldSuppressFileMentionPopupOnPaste(pastedText);
    const isLarge = isLargePlainTextPaste(pastedText, {
      charThreshold: this.charThreshold,
      lineThreshold: this.lineThreshold,
    });

    if (!isLarge) {
      this.pendingPaste = null;
      this.lastInlinePaste = null;
      this.replaceRangeInDocument(startOffset, endOffset, pastedText);
      return {
        action: 'inline',
        intercepted: false,
        text: this.documentText,
        cursorOffset: this.cursorOffset,
        attachment: null,
        pendingPaste: null,
        inlinePasteRecord: null,
        replacedRange: null,
        suppressFileMentionPopupOnPaste: suppressMention,
        offerId: null,
      };
    }

    if (effectiveMode === 'attach') {
      this.pendingPaste = null;
      this.lastInlinePaste = null;
      const attachment = this.allocateVirtualAttachment(pastedText);
      this.replaceRangeInDocument(startOffset, endOffset, attachment.chipToken);
      return {
        action: 'attach',
        intercepted: true,
        text: this.documentText,
        cursorOffset: this.cursorOffset,
        attachment,
        pendingPaste: null,
        inlinePasteRecord: null,
        replacedRange: { startOffset, endOffset },
        suppressFileMentionPopupOnPaste: false,
        offerId: null,
      };
    }

    if (effectiveMode === 'inline-double-paste') {
      this.pendingPaste = null;
      const previous = this.lastInlinePaste;
      const elapsedMs = previous ? nowMs - previous.timestampMs : Number.POSITIVE_INFINITY;
      const isSecondDoublePaste =
        previous !== null &&
        elapsedMs >= 0 &&
        elapsedMs <= this.doublePasteWindowMs &&
        startOffset === previous.endOffset &&
        endOffset === previous.endOffset &&
        pastedText === previous.text &&
        this.documentText.slice(previous.startOffset, previous.endOffset) === previous.text;

      if (isSecondDoublePaste && previous) {
        const attachment = this.allocateVirtualAttachment(pastedText);
        const replacedRange = {
          startOffset: previous.startOffset,
          endOffset: previous.endOffset,
        };
        this.lastInlinePaste = null;
        this.replaceRangeInDocument(replacedRange.startOffset, replacedRange.endOffset, attachment.chipToken);
        return {
          action: 'double-paste-attach',
          intercepted: true,
          text: this.documentText,
          cursorOffset: this.cursorOffset,
          attachment,
          pendingPaste: null,
          inlinePasteRecord: null,
          replacedRange,
          suppressFileMentionPopupOnPaste: false,
          offerId: null,
        };
      }

      this.replaceRangeInDocument(startOffset, endOffset, pastedText);
      const record: InlineDoublePasteRecord = {
        text: pastedText,
        startOffset,
        endOffset: this.cursorOffset,
        timestampMs: nowMs,
      };
      this.lastInlinePaste = record;
      return {
        action: 'inline',
        intercepted: false,
        text: this.documentText,
        cursorOffset: this.cursorOffset,
        attachment: null,
        pendingPaste: null,
        inlinePasteRecord: { ...record },
        replacedRange: null,
        suppressFileMentionPopupOnPaste: suppressMention,
        offerId: null,
      };
    }

    // 'ask' mode: suspend paste and open choice capsule
    this.lastInlinePaste = null;
    this.offerCounter += 1;
    const pending: PendingLargeTextPaste = {
      offerId: this.offerCounter,
      content: pastedText,
      startOffset,
      endOffset,
      timestampMs: nowMs,
    };
    this.pendingPaste = pending;

    return {
      action: 'pending-ask',
      intercepted: true,
      text: this.documentText,
      cursorOffset: this.cursorOffset,
      attachment: null,
      pendingPaste: { ...pending },
      inlinePasteRecord: null,
      replacedRange: null,
      suppressFileMentionPopupOnPaste: suppressMention,
      offerId: pending.offerId,
    };
  }

  confirmAttach(): LargeTextPasteResult {
    const pending = this.pendingPaste;
    if (!pending) {
      return {
        action: 'noop',
        intercepted: false,
        text: this.documentText,
        cursorOffset: this.cursorOffset,
        attachment: null,
        pendingPaste: null,
        inlinePasteRecord: null,
        replacedRange: null,
        suppressFileMentionPopupOnPaste: false,
        offerId: null,
      };
    }

    this.pendingPaste = null;
    const attachment = this.allocateVirtualAttachment(pending.content);
    this.replaceRangeInDocument(pending.startOffset, pending.endOffset, attachment.chipToken);

    return {
      action: 'attach',
      intercepted: true,
      text: this.documentText,
      cursorOffset: this.cursorOffset,
      attachment,
      pendingPaste: null,
      inlinePasteRecord: null,
      replacedRange: { startOffset: pending.startOffset, endOffset: pending.endOffset },
      suppressFileMentionPopupOnPaste: false,
      offerId: pending.offerId,
    };
  }

  confirmInline(): LargeTextPasteResult {
    const pending = this.pendingPaste;
    if (!pending) {
      return {
        action: 'noop',
        intercepted: false,
        text: this.documentText,
        cursorOffset: this.cursorOffset,
        attachment: null,
        pendingPaste: null,
        inlinePasteRecord: null,
        replacedRange: null,
        suppressFileMentionPopupOnPaste: false,
        offerId: null,
      };
    }

    this.pendingPaste = null;
    this.replaceRangeInDocument(pending.startOffset, pending.endOffset, pending.content);

    return {
      action: 'inline',
      intercepted: false,
      text: this.documentText,
      cursorOffset: this.cursorOffset,
      attachment: null,
      pendingPaste: null,
      inlinePasteRecord: null,
      replacedRange: { startOffset: pending.startOffset, endOffset: pending.endOffset },
      suppressFileMentionPopupOnPaste: shouldSuppressFileMentionPopupOnPaste(pending.content),
      offerId: pending.offerId,
    };
  }

  /**
   * Seamless capsule type-through: when the user presses a printable character
   * while the ask capsule is pending, immediately dismisses the capsule, inserts
   * the pending large text inline at the cursor, and appends `printableChar` right after it.
   */
  typeThrough(printableChar: string): LargeTextPasteResult {
    const pending = this.pendingPaste;
    if (!pending || !printableChar) {
      return {
        action: 'noop',
        intercepted: false,
        text: this.documentText,
        cursorOffset: this.cursorOffset,
        attachment: null,
        pendingPaste: this.getPendingPaste(),
        inlinePasteRecord: null,
        replacedRange: null,
        suppressFileMentionPopupOnPaste: false,
        offerId: pending?.offerId ?? null,
      };
    }

    this.pendingPaste = null;
    const combinedInsertion = `${pending.content}${printableChar}`;
    this.replaceRangeInDocument(pending.startOffset, pending.endOffset, combinedInsertion);

    return {
      action: 'type-through',
      intercepted: false,
      text: this.documentText,
      cursorOffset: this.cursorOffset,
      attachment: null,
      pendingPaste: null,
      inlinePasteRecord: null,
      replacedRange: { startOffset: pending.startOffset, endOffset: pending.endOffset },
      suppressFileMentionPopupOnPaste: shouldSuppressFileMentionPopupOnPaste(pending.content),
      offerId: pending.offerId,
    };
  }
}

// ============================================================================
// 2. Floating Approval / Form Dock Preemption & Clearance CSS Var Sync
// ============================================================================

export type BlockingRequestDismissReason = 'chat-sent-earlier';

export interface FloatingBlockingRequest {
  id: string;
  sessionId?: string;
  dismissed?: boolean;
  reason?: BlockingRequestDismissReason;
  [key: string]: unknown;
}

export type DismissedFloatingBlockingRequest<
  T extends FloatingBlockingRequest = FloatingBlockingRequest,
> = T & {
  dismissed: true;
  reason: 'chat-sent-earlier';
};

export interface PreemptFloatingBlockingRequestsParams<
  TApproval extends FloatingBlockingRequest = FloatingBlockingRequest,
  TForm extends FloatingBlockingRequest = FloatingBlockingRequest,
> {
  sessionId?: string | null;
  pendingApprovals?: readonly TApproval[];
  pendingForms?: readonly TForm[];
  onDismissApproval?: (
    dismissedItem: DismissedFloatingBlockingRequest<TApproval>,
  ) => void | Promise<void>;
  onDismissForm?: (
    dismissedItem: DismissedFloatingBlockingRequest<TForm>,
  ) => void | Promise<void>;
  onSendOutboundMessage?: () => void | Promise<void>;
}

export interface PreemptFloatingBlockingRequestsResult<
  TApproval extends FloatingBlockingRequest = FloatingBlockingRequest,
  TForm extends FloatingBlockingRequest = FloatingBlockingRequest,
> {
  preempted: boolean;
  allowOutboundSend: true;
  reason: 'chat-sent-earlier' | null;
  dismissedApprovals: Array<DismissedFloatingBlockingRequest<TApproval>>;
  dismissedForms: Array<DismissedFloatingBlockingRequest<TForm>>;
  remainingApprovals: TApproval[];
  remainingForms: TForm[];
  executionOrder: string[];
}

function belongsToTargetSession(
  itemSessionId: string | undefined,
  targetSessionId: string | null | undefined,
): boolean {
  if (!targetSessionId) return false;
  if (!itemSessionId) {
    return true;
  }
  return itemSessionId === targetSessionId;
}

/**
 * Optimistically preempts and dismisses all pending floating approvals and forms
 * (`{ dismissed: true, reason: 'chat-sent-earlier' }`) when the user sends a new
 * message directly from the composer, then releases the outbound message.
 */
export function preemptFloatingBlockingRequestsOnSend<
  TApproval extends FloatingBlockingRequest = FloatingBlockingRequest,
  TForm extends FloatingBlockingRequest = FloatingBlockingRequest,
>(
  params: PreemptFloatingBlockingRequestsParams<TApproval, TForm>,
): PreemptFloatingBlockingRequestsResult<TApproval, TForm> {
  const {
    sessionId,
    pendingApprovals = [],
    pendingForms = [],
    onDismissApproval,
    onDismissForm,
    onSendOutboundMessage,
  } = params;

  const dismissedApprovals: Array<DismissedFloatingBlockingRequest<TApproval>> = [];
  const remainingApprovals: TApproval[] = [];
  const dismissedForms: Array<DismissedFloatingBlockingRequest<TForm>> = [];
  const remainingForms: TForm[] = [];
  const executionOrder: string[] = [];

  for (const approval of pendingApprovals) {
    if (!approval.dismissed && belongsToTargetSession(approval.sessionId, sessionId)) {
      const dismissedItem: DismissedFloatingBlockingRequest<TApproval> = {
        ...approval,
        dismissed: true,
        reason: 'chat-sent-earlier',
      };
      dismissedApprovals.push(dismissedItem);
      executionOrder.push(`dismiss-approval:${approval.id}`);
      void onDismissApproval?.(dismissedItem);
    } else if (!approval.dismissed) {
      remainingApprovals.push(approval);
    }
  }

  for (const form of pendingForms) {
    if (!form.dismissed && belongsToTargetSession(form.sessionId, sessionId)) {
      const dismissedItem: DismissedFloatingBlockingRequest<TForm> = {
        ...form,
        dismissed: true,
        reason: 'chat-sent-earlier',
      };
      dismissedForms.push(dismissedItem);
      executionOrder.push(`dismiss-form:${form.id}`);
      void onDismissForm?.(dismissedItem);
    } else if (!form.dismissed) {
      remainingForms.push(form);
    }
  }

  const preempted = dismissedApprovals.length > 0 || dismissedForms.length > 0;
  if (onSendOutboundMessage) {
    executionOrder.push('send-outbound');
    void onSendOutboundMessage();
  }

  return {
    preempted,
    allowOutboundSend: true,
    reason: preempted ? 'chat-sent-earlier' : null,
    dismissedApprovals,
    dismissedForms,
    remainingApprovals,
    remainingForms,
    executionOrder,
  };
}

/**
 * Directly writes `--chat-floating-panel-clearance: ${panelHeightPx}px` onto the
 * container DOM style without triggering React message list re-renders.
 */
export function syncFloatingPanelClearanceCssVar(
  containerEl: Pick<HTMLElement, 'style'> | null | undefined,
  panelHeightPx: number | null | undefined,
): string {
  if (!containerEl?.style) {
    return '';
  }

  if (
    panelHeightPx === null ||
    panelHeightPx === undefined ||
    Number.isNaN(panelHeightPx) ||
    panelHeightPx < 0
  ) {
    containerEl.style.removeProperty(FLOATING_PANEL_CLEARANCE_CSS_VAR);
    return '';
  }

  const value = `${panelHeightPx}px`;
  if (containerEl.style.getPropertyValue(FLOATING_PANEL_CLEARANCE_CSS_VAR) !== value) {
    containerEl.style.setProperty(FLOATING_PANEL_CLEARANCE_CSS_VAR, value);
  }
  return value;
}

// ============================================================================
// 3. Double-Escape Anti-Misfire Stop Generation Guard
// ============================================================================

export interface DoubleEscapeStopGuardOptions {
  windowMs?: number;
  now?: () => number;
}

export interface DoubleEscapeContext {
  repeat?: boolean;
  hasOpenOverlay?: boolean;
  nowMs?: number;
  key?: string;
}

export interface DoubleEscapeEvalResult {
  shouldStop: boolean;
  armed: boolean;
}

export class DoubleEscapeStopGuard {
  private readonly windowMs: number;
  private readonly now: () => number;
  private armedAtMs: number | null = null;

  constructor(optionsOrWindowMs?: number | DoubleEscapeStopGuardOptions) {
    if (typeof optionsOrWindowMs === 'number') {
      this.windowMs = optionsOrWindowMs;
      this.now = () => Date.now();
    } else {
      this.windowMs = optionsOrWindowMs?.windowMs ?? DOUBLE_ESCAPE_WINDOW_MS;
      this.now = optionsOrWindowMs?.now ?? (() => Date.now());
    }
  }

  getWindowMs(): number {
    return this.windowMs;
  }

  isArmed(nowMs?: number): boolean {
    if (this.armedAtMs === null) {
      return false;
    }
    const currentNow = nowMs ?? this.now();
    const elapsed = currentNow - this.armedAtMs;
    return elapsed >= 0 && elapsed <= this.windowMs;
  }

  reset(): void {
    this.armedAtMs = null;
  }

  handleEscape(context?: DoubleEscapeContext): DoubleEscapeEvalResult {
    if (context?.repeat) return { shouldStop: false, armed: this.isArmed(context.nowMs) };
    if (context?.key !== undefined && context.key !== 'Escape') {
      this.armedAtMs = null;
      return { shouldStop: false, armed: false };
    }

    const hasOpenOverlay = context?.hasOpenOverlay ?? false;
    if (hasOpenOverlay) {
      this.armedAtMs = null;
      return { shouldStop: false, armed: false };
    }

    const currentNow = context?.nowMs ?? this.now();
    if (this.armedAtMs !== null) {
      const elapsed = currentNow - this.armedAtMs;
      if (elapsed >= 0 && elapsed <= this.windowMs) {
        this.armedAtMs = null;
        return { shouldStop: true, armed: false };
      }
    }

    this.armedAtMs = currentNow;
    return { shouldStop: false, armed: true };
  }

  pressEscape(context?: DoubleEscapeContext): DoubleEscapeEvalResult {
    return this.handleEscape(context);
  }
}

// ============================================================================
// 4. Triplet 50-Entry LRU Session Draft Store with @mention Confirmation State
// ============================================================================

export type ConfirmedComposerMentionKind = 'file' | 'agent' | 'session' | 'skill';

export interface ConfirmedComposerMention {
  kind: ConfirmedComposerMentionKind;
  token: string;
  targetId: string;
}

export interface SessionDraftTripletKeyInput {
  runtimeKey: string;
  directory: string;
  sessionIdOrWorkDraftKey: string;
}

export interface SessionDraftRecord {
  compositeKey: string;
  runtimeKey: string;
  normalizedDirectory: string;
  sessionIdOrWorkDraftKey: string;
  text: string;
  confirmedMentions: ConfirmedComposerMention[];
  pastedSessionIds: string[];
  suppressFileMentionPopupOnPaste: boolean;
  updatedAtMs: number;
}

export interface SaveSessionDraftInput {
  runtimeKey?: string;
  directory?: string;
  sessionIdOrWorkDraftKey?: string;
  text: string;
  confirmedMentions?: readonly ConfirmedComposerMention[];
  pastedSessionIds?: readonly string[];
  suppressFileMentionPopupOnPaste?: boolean;
  pastedText?: string;
  updatedAtMs?: number;
}

export interface DraftStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionDraftLruStoreOptions {
  maxEntries?: number;
  storageKey?: string;
  storage?: DraftStorageLike | null;
  now?: () => number;
}

/**
 * Normalizes a directory path for the triplet composite key.
 */
export function normalizeDraftDirectoryPath(directory: string): string {
  const trimmed = (directory ?? '').trim().replace(/\\/g, '/');
  if (!trimmed) {
    return '/';
  }
  const collapsed = trimmed.replace(/\/+/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

/**
 * Formats the composite key `${runtimeKey}::${normalizedDirectory}::${sessionIdOrWorkDraftKey}`.
 */
export function buildSessionDraftCompositeKey(input: SessionDraftTripletKeyInput): string {
  const runtimeKey = input.runtimeKey.trim() || 'default';
  const normalizedDirectory = normalizeDraftDirectoryPath(input.directory);
  const sessionKey = input.sessionIdOrWorkDraftKey.trim() || 'work-draft';
  return [runtimeKey, normalizedDirectory, sessionKey]
    .map((part) => part.replace(/%/g, '%25').replace(/::/g, '%3A%3A')).join('::');
}

/**
 * Parses a composite key `${runtimeKey}::${normalizedDirectory}::${sessionIdOrWorkDraftKey}`.
 */
export function parseSessionDraftCompositeKey(compositeKey: string): SessionDraftTripletKeyInput | null {
  const parts = compositeKey.split('::');
  if (parts.length < 3) {
    return null;
  }
  if (parts.length !== 3) return null;
  let decoded: string[];
  try { decoded = parts.map(decodeURIComponent); } catch { return null; }
  const [runtimeKey, directory, sessionIdOrWorkDraftKey] = decoded;
  if (!runtimeKey || !directory || !sessionIdOrWorkDraftKey) {
    return null;
  }
  return {
    runtimeKey,
    directory: normalizeDraftDirectoryPath(directory),
    sessionIdOrWorkDraftKey,
  };
}

/**
 * Returns true when pasted plain text contains `@` and should suppress the
 * file mention autocomplete popup on paste.
 */
export function shouldSuppressFileMentionPopupOnPaste(pastedText: string): boolean {
  return Boolean(pastedText && pastedText.includes('@'));
}

function deduplicateConfirmedMentions(
  mentions: readonly ConfirmedComposerMention[] = [],
): ConfirmedComposerMention[] {
  const seen = new Set<string>();
  const result: ConfirmedComposerMention[] = [];
  for (const mention of mentions) {
    if (!mention || !mention.token || !mention.targetId) {
      continue;
    }
    const dedupeKey = `${mention.kind}::${mention.token}::${mention.targetId}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    result.push({
      kind: mention.kind,
      token: mention.token,
      targetId: mention.targetId,
    });
  }
  return result;
}

function deduplicatePastedSessionIds(sessionIds: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawId of sessionIds) {
    const trimmed = rawId?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export class SessionDraftLruStore {
  private readonly maxEntries: number;
  private readonly storageKey: string;
  private readonly storage: DraftStorageLike | null;
  private readonly now: () => number;
  private entries = new Map<string, SessionDraftRecord>();

  constructor(options?: SessionDraftLruStoreOptions) {
    this.maxEntries = options?.maxEntries ?? MAX_DRAFT_ENTRIES;
    this.storageKey = options?.storageKey ?? DEFAULT_SESSION_DRAFT_LRU_STORAGE_KEY;
    this.storage = options?.storage ?? null;
    this.now = options?.now ?? (() => Date.now());
    this.hydrateFromStorage();
  }

  private resolveIdentity(
    identityOrCompositeKey: string | SessionDraftTripletKeyInput,
  ): {
    compositeKey: string;
    runtimeKey: string;
    normalizedDirectory: string;
    sessionIdOrWorkDraftKey: string;
  } {
    if (typeof identityOrCompositeKey === 'string') {
      const parsed = parseSessionDraftCompositeKey(identityOrCompositeKey);
      if (parsed) {
        const normalizedDirectory = normalizeDraftDirectoryPath(parsed.directory);
        return {
          compositeKey: buildSessionDraftCompositeKey(parsed),
          runtimeKey: parsed.runtimeKey.trim(),
          normalizedDirectory,
          sessionIdOrWorkDraftKey: parsed.sessionIdOrWorkDraftKey.trim(),
        };
      }
      return {
        compositeKey: identityOrCompositeKey,
        runtimeKey: 'default',
        normalizedDirectory: '/',
        sessionIdOrWorkDraftKey: identityOrCompositeKey,
      };
    }

    const normalizedDirectory = normalizeDraftDirectoryPath(identityOrCompositeKey.directory);
    const runtimeKey = identityOrCompositeKey.runtimeKey.trim() || 'default';
    const sessionIdOrWorkDraftKey =
      identityOrCompositeKey.sessionIdOrWorkDraftKey.trim() || 'work-draft';
    return {
      compositeKey: buildSessionDraftCompositeKey({ runtimeKey, directory: normalizedDirectory, sessionIdOrWorkDraftKey }),
      runtimeKey,
      normalizedDirectory,
      sessionIdOrWorkDraftKey,
    };
  }

  private hydrateFromStorage(): void {
    if (!this.storage) {
      return;
    }
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as { entries?: SessionDraftRecord[] };
      if (!Array.isArray(parsed?.entries)) {
        return;
      }
      const sorted = [...parsed.entries]
        .filter((item) => Boolean(item && typeof item.compositeKey === 'string'))
        .slice(0, this.maxEntries).reverse();
      this.entries.clear();
      for (const item of sorted) {
        this.entries.set(item.compositeKey, {
          compositeKey: item.compositeKey,
          runtimeKey: item.runtimeKey,
          normalizedDirectory: normalizeDraftDirectoryPath(item.normalizedDirectory),
          sessionIdOrWorkDraftKey: item.sessionIdOrWorkDraftKey,
          text: item.text ?? '',
          confirmedMentions: deduplicateConfirmedMentions(item.confirmedMentions),
          pastedSessionIds: deduplicatePastedSessionIds(item.pastedSessionIds),
          suppressFileMentionPopupOnPaste: Boolean(item.suppressFileMentionPopupOnPaste),
          updatedAtMs: Number(item.updatedAtMs) || 0,
        });
      }
    } catch {
      this.entries.clear();
    }
  }

  private persistToStorage(): void {
    if (!this.storage) {
      return;
    }
    try {
      if (this.entries.size === 0) {
        this.storage.removeItem(this.storageKey);
        return;
      }
      const serialized = JSON.stringify({
        version: 2,
        entries: this.listDrafts(),
      });
      this.storage.setItem(this.storageKey, serialized);
    } catch {
      // Ignore storage quota or security errors in restricted environments.
    }
  }

  private enforceLruLimit(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  setDraft(
    identityOrCompositeKey: string | SessionDraftTripletKeyInput,
    input: SaveSessionDraftInput,
  ): SessionDraftRecord | null {
    const resolved = this.resolveIdentity(identityOrCompositeKey);
    const confirmedMentions = deduplicateConfirmedMentions(input.confirmedMentions);
    const pastedSessionIds = deduplicatePastedSessionIds(input.pastedSessionIds);
    const text = input.text ?? '';

    const isEmptyDraft =
      text.trim().length === 0 &&
      confirmedMentions.length === 0 &&
      pastedSessionIds.length === 0;

    if (isEmptyDraft) {
      this.entries.delete(resolved.compositeKey);
      this.persistToStorage();
      return null;
    }

    const suppressFileMentionPopupOnPaste =
      input.suppressFileMentionPopupOnPaste ??
      (input.pastedText !== undefined
        ? shouldSuppressFileMentionPopupOnPaste(input.pastedText)
        : false);

    const record: SessionDraftRecord = {
      compositeKey: resolved.compositeKey,
      runtimeKey: resolved.runtimeKey,
      normalizedDirectory: resolved.normalizedDirectory,
      sessionIdOrWorkDraftKey: resolved.sessionIdOrWorkDraftKey,
      text,
      confirmedMentions,
      pastedSessionIds,
      suppressFileMentionPopupOnPaste,
      updatedAtMs: input.updatedAtMs ?? this.now(),
    };

    this.entries.delete(resolved.compositeKey);
    this.entries.set(resolved.compositeKey, record);
    this.enforceLruLimit();
    this.persistToStorage();

    return this.getDraft(resolved.compositeKey);
  }

  saveDraft(
    identityOrCompositeKey: string | SessionDraftTripletKeyInput,
    input: SaveSessionDraftInput,
  ): SessionDraftRecord | null {
    return this.setDraft(identityOrCompositeKey, input);
  }

  getDraft(identityOrCompositeKey: string | SessionDraftTripletKeyInput): SessionDraftRecord | null {
    const { compositeKey } = this.resolveIdentity(identityOrCompositeKey);
    const found = this.entries.get(compositeKey);
    if (!found) {
      return null;
    }
    return {
      ...found,
      confirmedMentions: found.confirmedMentions.map((mention) => ({ ...mention })),
      pastedSessionIds: [...found.pastedSessionIds],
    };
  }

  deleteDraft(identityOrCompositeKey: string | SessionDraftTripletKeyInput): boolean {
    const { compositeKey } = this.resolveIdentity(identityOrCompositeKey);
    const existed = this.entries.delete(compositeKey);
    if (existed) {
      this.persistToStorage();
    }
    return existed;
  }

  listDrafts(): SessionDraftRecord[] {
    return Array.from(this.entries.values())
      .reverse()
      .map((item) => ({
        ...item,
        confirmedMentions: item.confirmedMentions.map((mention) => ({ ...mention })),
        pastedSessionIds: [...item.pastedSessionIds],
      }));
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.persistToStorage();
  }
}
