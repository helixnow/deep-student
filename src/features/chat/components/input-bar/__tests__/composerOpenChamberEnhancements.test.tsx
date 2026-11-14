import { describe, expect, it, vi } from 'vitest';
import {
  buildSessionDraftCompositeKey,
  createVirtualPastedTextFile,
  DOUBLE_ESCAPE_WINDOW_MS,
  DOUBLE_PASTE_WINDOW_MS,
  DoubleEscapeStopGuard,
  FLOATING_PANEL_CLEARANCE_CSS_VAR,
  isLargePlainTextPaste,
  LARGE_TEXT_PASTE_CHAR_THRESHOLD,
  LARGE_TEXT_PASTE_LINE_THRESHOLD,
  LargeTextPasteController,
  MAX_DRAFT_ENTRIES,
  nextPastedContextFileName,
  normalizeDraftDirectoryPath,
  parseSessionDraftCompositeKey,
  preemptFloatingBlockingRequestsOnSend,
  SessionDraftLruStore,
  shouldSuppressFileMentionPopupOnPaste,
  syncFloatingPanelClearanceCssVar,
} from '../composerOpenChamberEnhancements';

describe('composerOpenChamberEnhancements', () => {
  // ==========================================================================
  // 1. LargeTextPasteController & Threshold Detection
  // ==========================================================================
  describe('LargeTextPasteController and threshold helpers', () => {
    it('evaluates isLargePlainTextPaste at >= 2000 chars or >= 25 lines and ignores empty/whitespace text', () => {
      expect(isLargePlainTextPaste('')).toBe(false);
      expect(isLargePlainTextPaste('   \n\n  ')).toBe(false);
      expect(isLargePlainTextPaste('x'.repeat(LARGE_TEXT_PASTE_CHAR_THRESHOLD - 1))).toBe(false);
      expect(isLargePlainTextPaste('x'.repeat(LARGE_TEXT_PASTE_CHAR_THRESHOLD))).toBe(true);

      const twentyFourLines = Array.from(
        { length: LARGE_TEXT_PASTE_LINE_THRESHOLD - 1 },
        (_, i) => `line-${i + 1}`,
      ).join('\n');
      const twentyFiveLines = Array.from(
        { length: LARGE_TEXT_PASTE_LINE_THRESHOLD },
        (_, i) => `line-${i + 1}`,
      ).join('\r\n');

      expect(isLargePlainTextPaste(twentyFourLines)).toBe(false);
      expect(isLargePlainTextPaste(twentyFiveLines)).toBe(true);
    });

    it('creates sequential virtual pasted-context-N.txt files and chips', () => {
      expect(nextPastedContextFileName([])).toBe('pasted-context-1.txt');
      expect(
        nextPastedContextFileName(['pasted-context-1.txt', 'PASTED-CONTEXT-2.TXT']),
      ).toBe('pasted-context-3.txt');

      const virtual = createVirtualPastedTextFile('hello world', ['pasted-context-1.txt']);
      expect(virtual.fileName).toBe('pasted-context-2.txt');
      expect(virtual.mimeType).toBe('text/plain');
      expect(virtual.content).toBe('hello world');
      expect(virtual.chipToken).toBe('[pasted-context-2.txt]');
    });

    it('handles ask mode: confirmAttach, confirmInline, and seamless typeThrough', () => {
      const controller = new LargeTextPasteController({
        mode: 'ask',
        initialText: 'Prefix: ',
        initialCursorOffset: 8,
      });

      const largeBlock = 'A'.repeat(2100);

      // 1) confirmAttach()
      const askOffer1 = controller.handlePaste(largeBlock, { timestampMs: 100 });
      expect(askOffer1.action).toBe('pending-ask');
      expect(askOffer1.intercepted).toBe(true);
      expect(controller.getDocumentText()).toBe('Prefix: ');
      expect(controller.hasPendingPaste()).toBe(true);

      const attachedResult = controller.confirmAttach();
      expect(attachedResult.action).toBe('attach');
      expect(attachedResult.attachment).toMatchObject({
        fileName: 'pasted-context-1.txt',
        mimeType: 'text/plain',
        content: largeBlock,
        chipToken: '[pasted-context-1.txt]',
      });
      expect(controller.getDocumentText()).toBe('Prefix: [pasted-context-1.txt]');
      expect(controller.hasPendingPaste()).toBe(false);

      // 2) confirmInline()
      controller.setDocumentState('Start ', 6);
      const largeLines = Array.from({ length: 26 }, (_, idx) => `row-${idx}`).join('\n');
      controller.handlePaste(largeLines, { timestampMs: 200 });
      const inlineResult = controller.confirmInline();
      expect(inlineResult.action).toBe('inline');
      expect(inlineResult.attachment).toBeNull();
      expect(controller.getDocumentText()).toBe(`Start ${largeLines}`);

      // 3) typeThrough(printableChar): closes capsule, inserts pending large text + printableChar seamlessly
      controller.setDocumentState('Review: ', 8);
      controller.handlePaste(largeBlock, { timestampMs: 300 });
      expect(controller.hasPendingPaste()).toBe(true);

      const typeThroughResult = controller.typeThrough('!');
      expect(typeThroughResult.action).toBe('type-through');
      expect(controller.hasPendingPaste()).toBe(false);
      expect(controller.getDocumentText()).toBe(`Review: ${largeBlock}!`);
      expect(controller.getCursorOffset()).toBe(`Review: ${largeBlock}!`.length);
    });

    it('handles attach mode by immediately converting large paste to virtual .txt and chip', () => {
      const controller = new LargeTextPasteController({
        mode: 'attach',
        initialText: 'Context ',
        initialCursorOffset: 8,
      });

      const largeText = 'B'.repeat(2050);
      const res = controller.handlePaste(largeText, { timestampMs: 500 });
      expect(res.action).toBe('attach');
      expect(res.intercepted).toBe(true);
      expect(res.attachment).toMatchObject({
        fileName: 'pasted-context-1.txt',
        mimeType: 'text/plain',
        content: largeText,
        chipToken: '[pasted-context-1.txt]',
      });
      expect(controller.getDocumentText()).toBe('Context [pasted-context-1.txt]');
    });

    it('handles inline-double-paste gesture within 1000ms window and invalidates on cursor move or timeout', () => {
      const controller = new LargeTextPasteController({
        mode: 'inline-double-paste',
        initialText: 'Header: ',
        initialCursorOffset: 8,
      });

      const largeSnippet = Array.from({ length: 30 }, (_, i) => `fn_${i}()`).join('\n');

      // 1st paste: inserts inline and records { text, startOffset, endOffset, timestampMs }
      const firstPaste = controller.handlePaste(largeSnippet, { timestampMs: 1000 });
      expect(firstPaste.action).toBe('inline');
      expect(firstPaste.intercepted).toBe(false);
      expect(firstPaste.inlinePasteRecord).toEqual({
        text: largeSnippet,
        startOffset: 8,
        endOffset: 8 + largeSnippet.length,
        timestampMs: 1000,
      });
      expect(controller.getDocumentText()).toBe(`Header: ${largeSnippet}`);

      // 2nd paste within 1000ms at endOffset: replaces [startOffset, endOffset] in-place with chip
      const secondPaste = controller.handlePaste(largeSnippet, {
        timestampMs: 1000 + DOUBLE_PASTE_WINDOW_MS - 150,
      });
      expect(secondPaste.action).toBe('double-paste-attach');
      expect(secondPaste.intercepted).toBe(true);
      expect(secondPaste.replacedRange).toEqual({
        startOffset: 8,
        endOffset: 8 + largeSnippet.length,
      });
      expect(secondPaste.attachment).toMatchObject({
        fileName: 'pasted-context-1.txt',
        mimeType: 'text/plain',
        content: largeSnippet,
        chipToken: '[pasted-context-1.txt]',
      });
      expect(controller.getDocumentText()).toBe('Header: [pasted-context-1.txt]');

      // If cursor moves or window expires (> 1000ms), 2nd paste does not convert in-place
      controller.setDocumentState('Next: ', 6);
      controller.handlePaste(largeSnippet, { timestampMs: 3000 });
      const expiredSecondPaste = controller.handlePaste(largeSnippet, {
        timestampMs: 3000 + DOUBLE_PASTE_WINDOW_MS + 50,
      });
      expect(expiredSecondPaste.action).toBe('inline');
      expect(expiredSecondPaste.attachment).toBeNull();

      // Moving cursor before 2nd paste invalidates gesture
      controller.setDocumentState('Moved: ', 7);
      controller.handlePaste(largeSnippet, { timestampMs: 5000 });
      controller.setCursorOffset(2);
      const movedCursorPaste = controller.handlePaste(largeSnippet, { timestampMs: 5200 });
      expect(movedCursorPaste.action).toBe('inline');
      expect(movedCursorPaste.attachment).toBeNull();
    });
  });

  // ==========================================================================
  // 2. Floating Approval / Form Dock Preemption & Clearance CSS Var Sync
  // ==========================================================================
  describe('preemptFloatingBlockingRequestsOnSend and syncFloatingPanelClearanceCssVar', () => {
    it('optimistically dismisses pending approvals and forms for the session before sending outbound message', () => {
      const dismissedApprovalsSpy = vi.fn();
      const dismissedFormsSpy = vi.fn();
      const outboundSendSpy = vi.fn();

      const result = preemptFloatingBlockingRequestsOnSend({
        sessionId: 'sess-alpha',
        pendingApprovals: [
          { id: 'perm-1', sessionId: 'sess-alpha', tool: 'shell' },
          { id: 'perm-other', sessionId: 'sess-beta', tool: 'write' },
        ],
        pendingForms: [
          { id: 'form-1', sessionId: 'sess-alpha', title: 'Select target' },
        ],
        onDismissApproval: dismissedApprovalsSpy,
        onDismissForm: dismissedFormsSpy,
        onSendOutboundMessage: outboundSendSpy,
      });

      expect(result.preempted).toBe(true);
      expect(result.allowOutboundSend).toBe(true);
      expect(result.reason).toBe('chat-sent-earlier');
      expect(result.dismissedApprovals).toEqual([
        {
          id: 'perm-1',
          sessionId: 'sess-alpha',
          tool: 'shell',
          dismissed: true,
          reason: 'chat-sent-earlier',
        },
      ]);
      expect(result.dismissedForms).toEqual([
        {
          id: 'form-1',
          sessionId: 'sess-alpha',
          title: 'Select target',
          dismissed: true,
          reason: 'chat-sent-earlier',
        },
      ]);
      expect(result.remainingApprovals).toEqual([
        { id: 'perm-other', sessionId: 'sess-beta', tool: 'write' },
      ]);
      expect(result.executionOrder).toEqual([
        'dismiss-approval:perm-1',
        'dismiss-form:form-1',
        'send-outbound',
      ]);
      expect(dismissedApprovalsSpy).toHaveBeenCalledTimes(1);
      expect(dismissedFormsSpy).toHaveBeenCalledTimes(1);
      expect(outboundSendSpy).toHaveBeenCalledTimes(1);
    });

    it('writes --chat-floating-panel-clearance directly onto DOM element style without React re-render', () => {
      const containerEl = document.createElement('div');
      expect(syncFloatingPanelClearanceCssVar(containerEl, 76)).toBe('76px');
      expect(containerEl.style.getPropertyValue(FLOATING_PANEL_CLEARANCE_CSS_VAR)).toBe('76px');

      expect(syncFloatingPanelClearanceCssVar(containerEl, 0)).toBe('0px');
      expect(containerEl.style.getPropertyValue(FLOATING_PANEL_CLEARANCE_CSS_VAR)).toBe('0px');

      expect(syncFloatingPanelClearanceCssVar(containerEl, null)).toBe('');
      expect(containerEl.style.getPropertyValue(FLOATING_PANEL_CLEARANCE_CSS_VAR)).toBe('');
    });
  });

  // ==========================================================================
  // 3. DoubleEscapeStopGuard
  // ==========================================================================
  describe('DoubleEscapeStopGuard', () => {
    it('arms on 1st Esc and triggers stop only on 2nd Esc within 600ms when no overlay is open', () => {
      const guard = new DoubleEscapeStopGuard({ windowMs: DOUBLE_ESCAPE_WINDOW_MS });

      // When an overlay/menu is open, Esc closes overlay and does not arm or stop
      expect(guard.handleEscape({ hasOpenOverlay: true, nowMs: 1000 })).toEqual({
        shouldStop: false,
        armed: false,
      });

      // 1st Esc without overlay arms the guard
      expect(guard.handleEscape({ hasOpenOverlay: false, nowMs: 1200 })).toEqual({
        shouldStop: false,
        armed: true,
      });
      expect(guard.isArmed(1500)).toBe(true);

      // 2nd Esc within 600ms stops generation and disarms
      expect(guard.handleEscape({ hasOpenOverlay: false, nowMs: 1200 + 450 })).toEqual({
        shouldStop: true,
        armed: false,
      });
      expect(guard.isArmed(1700)).toBe(false);

      // Pressing Esc after > 600ms window re-arms instead of stopping
      expect(guard.handleEscape({ hasOpenOverlay: false, nowMs: 2000 })).toEqual({
        shouldStop: false,
        armed: true,
      });
      expect(
        guard.handleEscape({ hasOpenOverlay: false, nowMs: 2000 + DOUBLE_ESCAPE_WINDOW_MS + 10 }),
      ).toEqual({
        shouldStop: false,
        armed: true,
      });
    });
  });

  // ==========================================================================
  // 4. SessionDraftLruStore
  // ==========================================================================
  describe('SessionDraftLruStore', () => {
    it('formats triplet composite keys and persists confirmedMentions, pastedSessionIds, and paste @ suppression', () => {
      expect(normalizeDraftDirectoryPath('C:\\Users\\dev\\project///')).toBe(
        'C:/Users/dev/project',
      );

      const triplet = {
        runtimeKey: 'local-opencode',
        directory: '/workspace/deep-student///',
        sessionIdOrWorkDraftKey: 'draft:work-1',
      };
      const compositeKey = buildSessionDraftCompositeKey(triplet);
      expect(compositeKey).toBe('local-opencode::/workspace/deep-student::draft:work-1');
      expect(parseSessionDraftCompositeKey(compositeKey)).toEqual({
        runtimeKey: 'local-opencode',
        directory: '/workspace/deep-student',
        sessionIdOrWorkDraftKey: 'draft:work-1',
      });

      expect(shouldSuppressFileMentionPopupOnPaste('contact user@example.com')).toBe(true);
      expect(shouldSuppressFileMentionPopupOnPaste('plain text without sigil')).toBe(false);

      const backingMap = new Map<string, string>();
      const mockStorage = {
        getItem: (key: string) => backingMap.get(key) ?? null,
        setItem: (key: string, val: string) => {
          backingMap.set(key, val);
        },
        removeItem: (key: string) => {
          backingMap.delete(key);
        },
      };

      const store = new SessionDraftLruStore({ storage: mockStorage });
      const saved = store.setDraft(triplet, {
        text: 'Check @src/App.tsx and @architect with $opencode',
        confirmedMentions: [
          { kind: 'file', token: '@src/App.tsx', targetId: 'src/App.tsx' },
          { kind: 'agent', token: '@architect', targetId: 'agent:architect' },
          { kind: 'session', token: '@ses_prev', targetId: 'ses_prev' },
          { kind: 'skill', token: '$opencode', targetId: 'skill:opencode' },
        ],
        pastedSessionIds: ['ses_prev', 'ses_prev', 'ses_other'],
        pastedText: 'pasted email user@domain.dev',
        updatedAtMs: 5000,
      });

      expect(saved).not.toBeNull();
      expect(saved?.compositeKey).toBe(compositeKey);
      expect(saved?.confirmedMentions).toHaveLength(4);
      expect(saved?.pastedSessionIds).toEqual(['ses_prev', 'ses_other']);
      expect(saved?.suppressFileMentionPopupOnPaste).toBe(true);

      // Re-hydrating from storage preserves all metadata
      const reloadedStore = new SessionDraftLruStore({ storage: mockStorage });
      const hydrated = reloadedStore.getDraft(compositeKey);
      expect(hydrated).toEqual(saved);

      // Saving an empty draft automatically removes the entry
      reloadedStore.setDraft(triplet, {
        text: '   ',
        confirmedMentions: [],
        pastedSessionIds: [],
        updatedAtMs: 6000,
      });
      expect(reloadedStore.getDraft(triplet)).toBeNull();
      expect(reloadedStore.size()).toBe(0);
    });

    it('strictly enforces MAX_DRAFT_ENTRIES = 50 LRU eviction ordered by updatedAtMs', () => {
      const store = new SessionDraftLruStore();

      for (let i = 1; i <= MAX_DRAFT_ENTRIES + 10; i += 1) {
        store.setDraft(
          {
            runtimeKey: 'rt',
            directory: `/repo/dir-${i}`,
            sessionIdOrWorkDraftKey: `ses-${i}`,
          },
          {
            text: `Draft content #${i}`,
            updatedAtMs: i * 100,
          },
        );
      }

      expect(store.size()).toBe(MAX_DRAFT_ENTRIES);

      // Entries 1..10 (oldest updatedAtMs) should be evicted; 11..60 retained
      for (let i = 1; i <= 10; i += 1) {
        expect(
          store.getDraft({
            runtimeKey: 'rt',
            directory: `/repo/dir-${i}`,
            sessionIdOrWorkDraftKey: `ses-${i}`,
          }),
        ).toBeNull();
      }

      for (let i = 11; i <= MAX_DRAFT_ENTRIES + 10; i += 1) {
        expect(
          store.getDraft({
            runtimeKey: 'rt',
            directory: `/repo/dir-${i}`,
            sessionIdOrWorkDraftKey: `ses-${i}`,
          })?.text,
        ).toBe(`Draft content #${i}`);
      }
    });
  });
});
