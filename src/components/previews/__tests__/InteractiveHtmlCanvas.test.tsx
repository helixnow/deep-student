import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INTERACTIVE_HTML_CANVAS_SANDBOX,
  InteractiveHtmlCanvas,
  MAX_LOCAL_EDIT_UNDO_STEPS,
  applyHtmlSearchReplacePatch,
  buildInteractiveHtmlCanvasDocument,
} from '../InteractiveHtmlCanvas';
import {
  WIDGET_STREAM_FRAME_CSP,
  WIDGET_STREAM_FRAME_SANDBOX,
  WidgetStreamFrame,
  buildWidgetStreamPreviewDocument,
  sanitizeWidgetStreamHtml,
} from '../WidgetStreamFrame';
import {
  MAX_WIDGET_STATE_BYTES,
  MAX_WIDGET_STATE_DEPTH,
  WIDGET_STATE_SYNC_EVENT,
  buildFollowUpContextFromWidgetState,
  clearWidgetLocalState,
  computeWidgetSourceHash,
  readWidgetLocalState,
  saveWidgetLocalState,
  subscribeWidgetLocalState,
  validateWidgetStatePayload,
} from '../widgetLocalState';

describe('InteractiveHtmlCanvas', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('enforces sandbox="allow-scripts" without allow-same-origin for opaque origin isolation', () => {
    const { container } = render(
      <InteractiveHtmlCanvas html='<div class="oc-box">Hello Canvas</div>' />,
    );
    const iframe = container.querySelector('iframe.interactive-html-canvas-frame');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.getAttribute('sandbox')).toBe(INTERACTIVE_HTML_CANVAS_SANDBOX);
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('injects host theme CSS variables, .oc-*/.ds-* preset classes, ResizeObserver, and window.dstu / window.openchamber / window.__wbw bridge', () => {
    const doc = buildInteractiveHtmlCanvasDocument({
      html: '<div class="oc-box"><button class="oc-button" onclick="window.dstu.submit({ok:1}, \'Done\')">Go</button></div>',
      canvasId: 'canvas-test-1',
      answer: { chosen: 'A' },
      widgetState: { modelContent: { step: 2 }, privateContent: { draft: 'note' } },
      answerInput: { answer: 'opt-1', submitted: false, question: 'Pick one' },
    });

    expect(doc).toContain('--background:');
    expect(doc).toContain('--foreground:');
    expect(doc).toContain('--primary:');
    expect(doc).toContain('--radius:');
    expect(doc).toContain('--font-sans:');
    expect(doc).toContain('--font-mono:');
    expect(doc).toContain('.oc-box, .ds-box');
    expect(doc).toContain('.oc-option, .ds-option');
    expect(doc).toContain('.oc-button, .ds-button');
    expect(doc).toContain('window.dstu = bridge;');
    expect(doc).toContain('window.openchamber = bridge;');
    expect(doc).toContain('window.__wbw = bridge;');
    expect(doc).toContain('setWidgetState:');
    expect(doc).toContain('setAnswerDraft:');
    expect(doc).toContain('submitAnswer:');
    expect(doc).toContain('wbw:statechange');
    expect(doc).toContain('wbw:themechange');
    expect(doc).toContain('ds-canvas-resize');
    expect(doc).toContain('ds-canvas-submit');
    expect(doc).toContain('{"chosen":"A"}');
    expect(doc).toContain('"step":2');
  });

  it('updates stage height on ds-canvas-resize and invokes onSubmit on ds-canvas-submit postMessage', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <InteractiveHtmlCanvas
        html='<button class="ds-button">Pick</button>'
        onSubmit={onSubmit}
      />,
    );

    const stage = container.querySelector('[data-interactive-html-canvas]') as HTMLElement;
    const canvasId = stage.getAttribute('data-canvas-id')!;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'ds-canvas-resize',
            canvasId,
            height: 360,
          },
        }),
      );
    });

    expect(stage.style.height).toBe('360px');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'ds-canvas-submit',
            canvasId,
            data: { plan: 'pro', seats: 5 },
            summary: 'Pro Plan (5 seats)',
          },
        }),
      );
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ plan: 'pro', seats: 5 }, 'Pro Plan (5 seats)');
  });

  it('validates and persists widgetState via postMessage bridge and supports visual question answerInput callbacks', async () => {
    const onWidgetStateChange = vi.fn();
    const onDraftChange = vi.fn();
    const onSubmitAnswer = vi.fn();

    const { container } = render(
      <InteractiveHtmlCanvas
        widgetId="widget-bridge-1"
        html='<div class="ds-box">Interactive parabola</div>'
        onWidgetStateChange={onWidgetStateChange}
        answerInput={{
          answer: { selected: 'A' },
          submitted: false,
          question: 'Which curve is steeper?',
          onDraftChange,
          onSubmitAnswer,
        }}
      />,
    );

    const stage = container.querySelector('[data-interactive-html-canvas]') as HTMLElement;
    const canvasId = stage.getAttribute('data-canvas-id')!;

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'ds-canvas-set-widget-state',
            canvasId,
            requestId: 1,
            state: {
              modelContent: { a: 2, vertex: [0, 0] },
              privateContent: { scratchpad: 'local-only' },
            },
          },
        }),
      );
    });

    expect(onWidgetStateChange).toHaveBeenCalledTimes(1);
    expect(onWidgetStateChange.mock.calls[0][0]).toMatchObject({
      modelContent: { a: 2, vertex: [0, 0] },
      privateContent: { scratchpad: 'local-only' },
    });

    const persisted = readWidgetLocalState({
      widgetId: 'widget-bridge-1',
      source: '<div class="ds-box">Interactive parabola</div>',
    });
    expect(persisted?.modelContent).toEqual({ a: 2, vertex: [0, 0] });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'ds-canvas-answer-draft',
            canvasId,
            requestId: 2,
            draft: { selected: 'B' },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'ds-canvas-answer-submit',
            canvasId,
            requestId: 3,
            answer: { selected: 'B', confirmed: true },
          },
        }),
      );
    });

    expect(onDraftChange).toHaveBeenCalledWith({ selected: 'B' });
    expect(onSubmitAnswer).toHaveBeenCalledWith({ selected: 'B', confirmed: true });
  });

  it('keeps WidgetStreamFrame first-frame preview during streaming and before ready, then reveals executable frame on ready', () => {
    const html = '<style>.title{color:green}</style><div class="oc-box title">First Frame</div>';
    const { rerender } = render(<InteractiveHtmlCanvas html={html} streaming={true} />);

    // While streaming, script-free first frame is shown
    expect(screen.getByTestId('widget-stream-frame')).toBeInTheDocument();

    // After streaming finishes, before executable iframe triggers ready, first frame remains visible
    rerender(<InteractiveHtmlCanvas html={html} streaming={false} />);
    expect(screen.getByTestId('widget-stream-frame')).toBeInTheDocument();

    const stage = document.querySelector('[data-interactive-html-canvas]') as HTMLElement;
    const canvasId = stage.getAttribute('data-canvas-id')!;

    // When executable iframe signals ready, first frame disappears smoothly
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'ds-canvas-ready',
            canvasId,
          },
        }),
      );
    });

    expect(screen.queryByTestId('widget-stream-frame')).toBeNull();
  });

  it('supports expanded view with top-left back arrow without losing current widgetState snapshot', () => {
    const html = '<div class="ds-box">二次函数顶点式</div>';
    const { container } = render(
      <InteractiveHtmlCanvas
        widgetId="widget-expand-test"
        workTitle="二次函数参数探索"
        html={html}
      />,
    );

    expect(screen.getByTestId('canvas-work-title')).toHaveTextContent('二次函数参数探索');
    expect(screen.getByTestId('canvas-status-dot')).toHaveClass('h-1.5', 'w-1.5', 'rounded-full');
    expect(screen.getByTestId('canvas-version-badge')).toHaveTextContent('v1');
    expect(screen.getByTestId('canvas-version-badge')).toHaveClass('font-mono', 'tabular-nums');

    const stage = container.querySelector('[data-interactive-html-canvas]') as HTMLElement;
    const canvasId = stage.getAttribute('data-canvas-id')!;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'ds-canvas-set-widget-state',
            canvasId,
            requestId: 10,
            state: {
              modelContent: { k: 3.5 },
              privateContent: { hintOpen: true },
            },
          },
        }),
      );
    });

    // Click expand button in top bar
    fireEvent.click(screen.getByTestId('canvas-expand-button'));
    expect(screen.getByTestId('canvas-expanded-view')).toBeInTheDocument();

    const backButton = screen.getByTestId('canvas-expanded-back');
    expect(backButton).toHaveTextContent('返回');

    // Snapshot is preserved across expand
    const snapshotInExpanded = readWidgetLocalState({
      widgetId: 'widget-expand-test',
      source: html,
    });
    expect(snapshotInExpanded?.modelContent).toEqual({ k: 3.5 });
    expect(snapshotInExpanded?.privateContent).toEqual({ hintOpen: true });

    // Click top-left back arrow to exit expanded view
    fireEvent.click(backButton);
    expect(screen.queryByTestId('canvas-expanded-view')).toBeNull();
    expect(screen.getByTestId('interactive-html-canvas-root')).toBeInTheDocument();

    const snapshotAfterBack = readWidgetLocalState({
      widgetId: 'widget-expand-test',
      source: html,
    });
    expect(snapshotAfterBack?.modelContent).toEqual({ k: 3.5 });
  });

  it('supports inline local edit search/replace patches and maintains a 10-step undo stack', () => {
    const initialHtml = '<div class="ds-box">Step 0</div>';
    render(
      <InteractiveHtmlCanvas
        widgetId="widget-edit-undo"
        workTitle="算法单步演示"
        html={initialHtml}
      />,
    );

    expect(screen.getByTestId('canvas-version-badge')).toHaveTextContent('v1');
    expect(screen.queryByTestId('canvas-undo-button')).toBeNull();

    // Open inline local edit bar
    fireEvent.click(screen.getByTestId('canvas-toggle-edit'));
    expect(screen.getByTestId('canvas-local-edit-bar')).toBeInTheDocument();

    // Apply 12 sequential patches; undo stack should cap at 10
    for (let i = 1; i <= 12; i += 1) {
      fireEvent.change(screen.getByTestId('canvas-patch-search'), {
        target: { value: `Step ${i - 1}` },
      });
      fireEvent.change(screen.getByTestId('canvas-patch-replace'), {
        target: { value: `Step ${i}` },
      });
      fireEvent.click(screen.getByTestId('canvas-apply-patch'));
    }

    expect(screen.getByTestId('canvas-version-badge')).toHaveTextContent('v13');
    const undoBtn = screen.getByTestId('canvas-undo-button');
    const undoCount = screen.getByTestId('canvas-undo-count');
    expect(undoBtn).toBeInTheDocument();
    expect(undoCount).toHaveClass('font-mono', 'tabular-nums');
    expect(undoCount).toHaveTextContent(`(${MAX_LOCAL_EDIT_UNDO_STEPS})`);

    // Toggle source view to verify current source is Step 12
    fireEvent.click(screen.getByTestId('canvas-toggle-source'));
    expect(screen.getByTestId('canvas-source-view')).toHaveTextContent('Step 12');

    // Undo once -> Step 11, remaining undo count (9)
    fireEvent.click(undoBtn);
    expect(screen.getByTestId('canvas-version-badge')).toHaveTextContent('v12');
    expect(screen.getByTestId('canvas-undo-count')).toHaveTextContent('(9)');
    expect(screen.getByTestId('canvas-source-view')).toHaveTextContent('Step 11');

    // Undo remaining 9 times -> back to Step 2 (since 12 edits capped at 10 undo steps)
    for (let i = 0; i < 9; i += 1) {
      fireEvent.click(screen.getByTestId('canvas-undo-button'));
    }
    expect(screen.queryByTestId('canvas-undo-button')).toBeNull();
    expect(screen.getByTestId('canvas-source-view')).toHaveTextContent('Step 2');
  });
});

describe('widgetLocalState', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearWidgetLocalState({ widgetId: 'w-test' });
  });

  it('enforces 16 KiB UTF-8 byte limit and 16-level nesting depth limit on pure JSON values', () => {
    // Valid state within limits
    const valid = validateWidgetStatePayload({
      modelContent: { alpha: 0.5, labels: ['A', 'B'] },
      privateContent: { collapsed: false },
    });
    expect(valid.modelContent).toEqual({ alpha: 0.5, labels: ['A', 'B'] });

    // Exceeding 16 KiB (16384 bytes) in UTF-8
    const oversizedText = '中'.repeat(6000); // 18000 UTF-8 bytes > 16384
    expect(() =>
      validateWidgetStatePayload({
        modelContent: { text: oversizedText },
      }),
    ).toThrow(/16 KiB/);
    expect(MAX_WIDGET_STATE_BYTES).toBe(16384);

    // Build 16-level nested object (allowed) vs 17-level nested object (rejected)
    let nested16: unknown = 'leaf';
    for (let i = 0; i < MAX_WIDGET_STATE_DEPTH; i += 1) {
      nested16 = { child: nested16 };
    }
    expect(() => validateWidgetStatePayload({ modelContent: nested16 })).not.toThrow();

    const nested17 = { extra: nested16 };
    expect(() => validateWidgetStatePayload({ modelContent: nested17 })).toThrow(/16 层/);

    // Reject non-JSON values (functions, NaN, Infinity, non-plain objects)
    expect(() =>
      validateWidgetStatePayload({ modelContent: { fn: () => {} } }),
    ).toThrow();
    expect(() =>
      validateWidgetStatePayload({ modelContent: { badNumber: Number.NaN } }),
    ).toThrow();
    expect(() =>
      validateWidgetStatePayload({ modelContent: new Date() }),
    ).toThrow();
  });

  it('isolates and clears old snapshots when sourceHash changes (source modified)', () => {
    const sourceV1 = '<div class="ds-box">Version 1</div>';
    const sourceV2 = '<div class="ds-box">Version 2</div>';

    const savedV1 = saveWidgetLocalState(
      { widgetId: 'w-test', source: sourceV1 },
      { modelContent: { count: 10 }, privateContent: { secretUi: 'hidden' } },
    );
    expect(savedV1.sourceHash).toBe(computeWidgetSourceHash(sourceV1));

    // Reading with matching source returns the snapshot
    expect(readWidgetLocalState({ widgetId: 'w-test', source: sourceV1 })?.modelContent).toEqual({
      count: 10,
    });

    // Reading with modified source (different sourceHash) isolates and clears the incompatible snapshot
    expect(readWidgetLocalState({ widgetId: 'w-test', source: sourceV2 })).toBeNull();
    // Old snapshot is also purged so it cannot be replayed
    expect(readWidgetLocalState({ widgetId: 'w-test', source: sourceV1 })).toBeNull();
  });

  it('synchronizes snapshots across listeners via CustomEvent(ds:widget-state-sync)', () => {
    const source = '<div class="ds-box">Sync Test</div>';
    const events: unknown[] = [];
    const unsubscribe = subscribeWidgetLocalState(
      { messageId: 'msg-sync-1', source },
      (snapshot) => {
        events.push(snapshot?.modelContent ?? null);
      },
    );

    const customSpy = vi.fn();
    window.addEventListener(WIDGET_STATE_SYNC_EVENT, customSpy);

    saveWidgetLocalState(
      { messageId: 'msg-sync-1', source },
      { modelContent: { frequency: 440 } },
    );

    expect(customSpy).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ frequency: 440 }]);

    unsubscribe();
    window.removeEventListener(WIDGET_STATE_SYNC_EVENT, customSpy);
  });

  it('extracts only modelContent and never leaks privateContent in buildFollowUpContextFromWidgetState', () => {
    const snapshot = saveWidgetLocalState(
      { widgetId: 'w-test', source: '<div>Quiz</div>' },
      {
        modelContent: { selectedOption: 'B', angle: 45 },
        privateContent: { internalAnswerKey: 'DO_NOT_LEAK_ME', timerMs: 9200 },
      },
    );

    const context = buildFollowUpContextFromWidgetState(snapshot, '为什么这个角度下斜率等于 1？');
    expect(context).toContain('为什么这个角度下斜率等于 1？');
    expect(context).toContain('不可信画板快照上下文');
    expect(context).toContain('"selectedOption":"B"');
    expect(context).toContain('"angle":45');
    expect(context).not.toContain('DO_NOT_LEAK_ME');
    expect(context).not.toContain('internalAnswerKey');
    expect(context).not.toContain('privateContent');
  });
});

describe('WidgetStreamFrame', () => {
  it('renders a script-free inert preview iframe with sandbox="allow-same-origin" and strict CSP', () => {
    const rawHtml = `
      <style>
        .graph-card { color: var(--primary); background-image: url(https://evil.example.com/track.png); }
      </style>
      <div id="main-card" class="oc-box graph-card" onclick="alert('xss')" onmouseover="steal()">
        <svg viewBox="0 0 100 40" class="w-full"><circle cx="20" cy="20" r="10" fill="currentColor" /></svg>
        <img src="https://evil.example.com/pixel.png" alt="remote" />
        <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="inline" />
        <a href="https://evil.example.com/phish">External</a>
        <a href="#section-2">Anchor</a>
      </div>
      <script>window.evil = true;</script>
      <script>unclosedStreamingScript(
    `;

    const { container } = render(<WidgetStreamFrame html={rawHtml} />);
    const root = screen.getByTestId('widget-stream-frame');
    const iframe = screen.getByTestId('widget-stream-iframe');

    expect(root.hasAttribute('inert')).toBe(true);
    expect(iframe.getAttribute('sandbox')).toBe(WIDGET_STREAM_FRAME_SANDBOX);
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts');

    const srcDoc = iframe.getAttribute('srcdoc') || '';
    expect(srcDoc).toContain(WIDGET_STREAM_FRAME_CSP);
    expect(srcDoc).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none';");
    expect(srcDoc).toContain('<body inert');
    expect(srcDoc).toContain('--background:');
    expect(srcDoc).toContain('.oc-box, .ds-box');

    // Preserves author <style>, class/id, and inline <svg>
    expect(srcDoc).toContain('.graph-card');
    expect(srcDoc).toContain('id="main-card"');
    expect(srcDoc).toContain('<svg viewBox="0 0 100 40"');
    expect(srcDoc).toContain('<circle cx="20" cy="20" r="10"');
    expect(srcDoc).toContain('href="#section-2"');
    expect(srcDoc).toContain('data:image/png;base64,');

    // Strips all <script>, inline on* handlers, and external URLs
    expect(srcDoc).not.toContain('<script');
    expect(srcDoc).not.toContain('window.evil');
    expect(srcDoc).not.toContain('unclosedStreamingScript');
    expect(srcDoc).not.toContain('onclick');
    expect(srcDoc).not.toContain('onmouseover');
    expect(srcDoc).not.toContain('evil.example.com');

    expect(container).toBeTruthy();
  });

  it('sanitizes standalone HTML fragments and builds stream preview documents deterministically', () => {
    const clean = sanitizeWidgetStreamHtml(
      '<div class="ds-box" onload="evil()"><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg></div><script>evil()</script>',
    );
    expect(clean).toContain('class="ds-box"');
    expect(clean).toContain('<svg viewBox="0 0 10 10">');
    expect(clean).not.toContain('onload');
    expect(clean).not.toContain('<script');

    const doc = buildWidgetStreamPreviewDocument({
      html: clean,
      themeVars: { '--primary': 'hsl(217 70% 50%)' },
      presetCss: '.ds-box { padding: 8px; }',
    });
    expect(doc).toContain('--primary: hsl(217 70% 50%);');
    expect(doc).toContain('<body inert data-widget-stream-root="">');
  });

  it('rejects ambiguous or overlapping patches in applyHtmlSearchReplacePatch', () => {
    const base = '<div><span>A</span><span>A</span></div>';
    expect(() =>
      applyHtmlSearchReplacePatch(base, { search: '<span>A</span>', replace: '<span>B</span>' }),
    ).toThrow(/多次/);
    expect(() =>
      applyHtmlSearchReplacePatch(base, { search: 'NOT_FOUND', replace: 'X' }),
    ).toThrow(/未在当前源码中找到/);
  });
});
