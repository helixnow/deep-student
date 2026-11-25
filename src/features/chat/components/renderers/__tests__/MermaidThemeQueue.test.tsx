import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let activeMermaidRenders = 0;
  let maxConcurrentMermaidRenders = 0;
  let renderDelayMs = 0;

  return {
    resetConcurrency: () => {
      activeMermaidRenders = 0;
      maxConcurrentMermaidRenders = 0;
      renderDelayMs = 0;
    },
    setRenderDelayMs: (ms: number) => {
      renderDelayMs = ms;
    },
    getMaxConcurrentMermaidRenders: () => maxConcurrentMermaidRenders,
    mermaidInitialize: vi.fn(),
    mermaidRender: vi.fn(async (_id: string, code: string) => {
      activeMermaidRenders += 1;
      maxConcurrentMermaidRenders = Math.max(maxConcurrentMermaidRenders, activeMermaidRenders);
      try {
        if (renderDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, renderDelayMs));
        }
        return {
          svg: `<svg aria-roledescription="flowchart-v2" viewBox="0 0 200 100"><text>${code.slice(0, 20)}</text></svg>`,
        };
      } finally {
        activeMermaidRenders -= 1;
      }
    }),
    vegaEmbed: vi.fn(async () => ({ finalize: vi.fn() })),
  };
});

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(async () => true),
}));

vi.mock('@/utils/lazyPrism', () => ({
  resolvePrismLanguage: () => null,
  getLoadedPrismGrammar: () => null,
  loadPrismLanguage: vi.fn(async () => null),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: mocks.mermaidInitialize,
    render: mocks.mermaidRender,
  },
}));

vi.mock('vega-embed', () => ({
  default: mocks.vegaEmbed,
}));

import { CodeBlock, enqueueMermaidRender } from '../CodeBlock';
import { RichCodeRenderer } from '../RichCodeRenderer';

interface ObserverRecord {
  target: Element;
  callback: IntersectionObserverCallback;
  observer: IntersectionObserver;
}

function installControllableIntersectionObserver() {
  const original = globalThis.IntersectionObserver;
  const records: ObserverRecord[] = [];

  class ControllableIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds: readonly number[] = [0];
    private readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      records.push({ target, callback: this.callback, observer: this });
    }

    unobserve(target: Element): void {
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].target === target && records[i].observer === this) {
          records.splice(i, 1);
        }
      }
    }

    disconnect(): void {
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].observer === this) {
          records.splice(i, 1);
        }
      }
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  globalThis.IntersectionObserver =
    ControllableIntersectionObserver as unknown as typeof IntersectionObserver;

  const setIntersecting = (target: Element, isIntersecting: boolean) => {
    const matching = records.filter((rec) => rec.target === target);
    for (const rec of matching) {
      const entry = {
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
      } as IntersectionObserverEntry;
      rec.callback([entry], rec.observer);
    }
  };

  const restore = () => {
    globalThis.IntersectionObserver = original;
  };

  return { records, setIntersecting, restore };
}

async function clickRunButton(container: HTMLElement): Promise<void> {
  const runBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
    btn.textContent?.startsWith('▶'),
  ) as HTMLButtonElement | undefined;
  expect(runBtn).toBeDefined();
  await act(async () => {
    runBtn!.click();
    await Promise.resolve();
  });
}

describe('Mermaid single-flight render queue & off-screen theme-toggle gating', () => {
  let restoreIO: (() => void) | null = null;

  beforeEach(() => {
    mocks.resetConcurrency();
    mocks.mermaidInitialize.mockClear();
    mocks.mermaidRender.mockClear();
    mocks.vegaEmbed.mockClear();
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
    document.body.classList.remove('dark');
  });

  afterEach(() => {
    restoreIO?.();
    restoreIO = null;
    cleanup();
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
    document.body.classList.remove('dark');
  });

  it('serializes concurrent enqueueMermaidRender tasks (max 1) and yields a macrotask between them', async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const p1 = enqueueMermaidRender(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push('start-1');
      // Schedule a macrotask while task 1 is active; it MUST run before task 2 starts
      // because the queue yields a macrotask between consecutive renders.
      setTimeout(() => events.push('macrotask-between'), 0);
      await Promise.resolve();
      events.push('end-1');
      active -= 1;
      return 'r1';
    });

    const pCancelled = enqueueMermaidRender(
      async () => {
        events.push('should-not-run');
        return 'cancelled';
      },
      { isCancelled: () => true },
    );

    const p2 = enqueueMermaidRender(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push('start-2');
      await Promise.resolve();
      events.push('end-2');
      active -= 1;
      return 'r2';
    });

    const results = await Promise.all([p1, pCancelled, p2]);
    expect(results).toEqual(['r1', undefined, 'r2']);
    expect(maxActive).toBe(1);
    expect(events).toEqual(['start-1', 'end-1', 'macrotask-between', 'start-2', 'end-2']);
  });

  it('continues draining queued Mermaid renders even if an earlier render rejects', async () => {
    const failing = enqueueMermaidRender(async () => {
      throw new Error('syntax error');
    });
    const succeeding = enqueueMermaidRender(async () => 'ok');

    await expect(failing).rejects.toThrow('syntax error');
    await expect(succeeding).resolves.toBe('ok');
  });

  it('defers theme-change Mermaid re-render for off-screen diagrams until scrolled into view', async () => {
    const io = installControllableIntersectionObserver();
    restoreIO = io.restore;
    document.documentElement.classList.add('dark');

    const { container } = render(
      <div>
        <div data-testid="diagram-visible">
          <CodeBlock className="language-mermaid">{'flowchart TD\n  V1 --> V2'}</CodeBlock>
        </div>
        <div data-testid="diagram-offscreen">
          <CodeBlock className="language-mermaid">{'flowchart TD\n  O1 --> O2'}</CodeBlock>
        </div>
      </div>,
    );

    const visibleWrapper = container.querySelector('[data-testid="diagram-visible"]') as HTMLElement;
    const offscreenWrapper = container.querySelector('[data-testid="diagram-offscreen"]') as HTMLElement;

    await clickRunButton(visibleWrapper);
    await clickRunButton(offscreenWrapper);

    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(2));

    const visiblePreview = visibleWrapper.querySelector('.mermaid-preview') as HTMLElement;
    const offscreenPreview = offscreenWrapper.querySelector('.mermaid-preview') as HTMLElement;
    expect(visiblePreview).not.toBeNull();
    expect(offscreenPreview).not.toBeNull();

    // Report diagram 1 visible and diagram 2 off-screen
    await act(async () => {
      io.setIntersecting(visiblePreview, true);
      io.setIntersecting(offscreenPreview, false);
    });

    // Toggle Dark -> Light: only visible diagram re-renders
    await act(async () => {
      document.documentElement.classList.remove('dark');
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(3));
    expect(mocks.mermaidRender.mock.calls[2][1]).toContain('V1 --> V2');
    expect(mocks.mermaidInitialize.mock.calls[2][0].theme).toBe('neutral');

    // Wait an extra macrotask tick to confirm off-screen diagram stays deferred
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mocks.mermaidRender).toHaveBeenCalledTimes(3);

    // Scroll off-screen diagram back into view -> now re-renders in light theme
    await act(async () => {
      io.setIntersecting(offscreenPreview, true);
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(4));
    expect(mocks.mermaidRender.mock.calls[3][1]).toContain('O1 --> O2');
    expect(mocks.mermaidInitialize.mock.calls[3][0].theme).toBe('neutral');
  });

  it('serializes multiple visible Mermaid diagrams on theme toggle so max concurrent mermaid.render() is 1', async () => {
    const io = installControllableIntersectionObserver();
    restoreIO = io.restore;
    document.documentElement.classList.add('dark');
    mocks.setRenderDelayMs(15);

    const { container } = render(
      <div>
        <div data-testid="m-1">
          <CodeBlock className="language-mermaid">{'flowchart TD\n  A1 --> A2'}</CodeBlock>
        </div>
        <div data-testid="m-2">
          <CodeBlock className="language-mermaid">{'flowchart TD\n  B1 --> B2'}</CodeBlock>
        </div>
      </div>,
    );

    const first = container.querySelector('[data-testid="m-1"]') as HTMLElement;
    const second = container.querySelector('[data-testid="m-2"]') as HTMLElement;

    await clickRunButton(first);
    await clickRunButton(second);
    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(2));

    expect(mocks.getMaxConcurrentMermaidRenders()).toBe(1);

    // Toggle Dark -> Light with both visible
    await act(async () => {
      document.documentElement.classList.remove('dark');
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(4));
    expect(mocks.getMaxConcurrentMermaidRenders()).toBe(1);
  });

  it('defers off-screen RichCodeRenderer theme re-renders until scrolled into view', async () => {
    const io = installControllableIntersectionObserver();
    restoreIO = io.restore;
    document.documentElement.classList.add('dark');

    const spec = JSON.stringify({
      data: { values: [{ a: 1 }] },
      mark: 'point',
      encoding: { x: { field: 'a', type: 'quantitative' } },
    });

    const { container } = render(<RichCodeRenderer kind="vega-lite" source={spec} />);
    await waitFor(() => expect(mocks.vegaEmbed).toHaveBeenCalledTimes(1));
    expect((mocks.vegaEmbed.mock.calls[0] as unknown[])[2]).toMatchObject({ theme: 'dark' });

    const root = container.querySelector('.rich-code-renderer') as HTMLElement;
    expect(root).not.toBeNull();

    // Mark off-screen and toggle Dark -> Light
    await act(async () => {
      io.setIntersecting(root, false);
      document.documentElement.classList.remove('dark');
      await Promise.resolve();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Still only 1 embed call while off-screen
    expect(mocks.vegaEmbed).toHaveBeenCalledTimes(1);

    // Scroll back into view -> now re-renders in light mode (no dark theme option)
    await act(async () => {
      io.setIntersecting(root, true);
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.vegaEmbed).toHaveBeenCalledTimes(2));
    expect((mocks.vegaEmbed.mock.calls[1] as unknown[])[2]).not.toHaveProperty('theme', 'dark');
  });
});
