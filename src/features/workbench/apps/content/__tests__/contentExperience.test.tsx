/**
 * O17 — ContentSkeleton / ContentEmptyState / load-phase 集成测试
 */
import React from 'react';
import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const panelProps: Array<Record<string, unknown>> = [];

vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    panelProps.push(props);
    return <div data-testid="unified-app-panel" />;
  },
}));

import { createContentWindowComponent } from '../ContentAppWindow';
import { ContentSkeleton, skeletonVariantForType } from '../ContentSkeleton';
import { ContentEmptyState } from '../ContentEmptyState';
import { useContentLoadPhase } from '../useContentLoadPhase';
import type { AppWindowProps } from '../../../core/types';

function makeWindowProps(overrides: Partial<AppWindowProps> = {}): AppWindowProps {
  return {
    windowId: 'win_1',
    instanceKey: 'note_123',
    launchPayload: undefined,
    isActive: true,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
    ...overrides,
  };
}

describe('skeletonVariantForType', () => {
  it('maps resource types to skeleton variants', () => {
    expect(skeletonVariantForType('textbook')).toBe('pdf');
    expect(skeletonVariantForType('exam')).toBe('pdf');
    expect(skeletonVariantForType('note')).toBe('text');
    expect(skeletonVariantForType('image')).toBe('image');
    expect(skeletonVariantForType('mindmap')).toBe('mindmap');
    expect(skeletonVariantForType('file')).toBe('generic');
    expect(skeletonVariantForType('unknown')).toBe('generic');
  });
});

describe('ContentSkeleton', () => {
  afterEach(() => cleanup());

  it('renders accessible loading status with variant attribute', () => {
    const { container } = render(<ContentSkeleton variant="pdf" phase="loading" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('data-variant')).toBe('pdf');
    expect(status.getAttribute('data-phase')).toBe('loading');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(container.querySelector('.wb-content-skeleton__page')).not.toBeNull();
  });

  it('renders mindmap canvas bones', () => {
    const { container } = render(<ContentSkeleton variant="mindmap" phase="fading" />);
    expect(screen.getByRole('status').getAttribute('data-phase')).toBe('fading');
    expect(container.querySelector('.wb-content-skeleton__map-node--root')).not.toBeNull();
  });
});

describe('ContentEmptyState', () => {
  afterEach(() => cleanup());

  it('renders title and optional description', () => {
    render(
      <ContentEmptyState title="缺少资源标识" description="请从资源库重新打开" />,
    );
    expect(screen.getByText('缺少资源标识')).toBeTruthy();
    expect(screen.getByText('请从资源库重新打开')).toBeTruthy();
    expect(document.querySelector('.wb-content-empty')).not.toBeNull();
  });
});

describe('createContentWindowComponent O17 integration', () => {
  beforeEach(() => {
    panelProps.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows ContentEmptyState when instanceKey is missing', () => {
    const NoteWindow = createContentWindowComponent('note');
    render(<NoteWindow {...makeWindowProps({ instanceKey: null })} />);
    expect(panelProps).toHaveLength(0);
    expect(document.querySelector('.wb-content-empty')).not.toBeNull();
    expect(screen.getByText(/缺少资源标识/)).toBeTruthy();
  });

  it('overlays type skeleton while loading, then fades on first title', () => {
    vi.useFakeTimers();
    const NoteWindow = createContentWindowComponent('note');
    const onTitleChange = vi.fn();
    render(<NoteWindow {...makeWindowProps({ onTitleChange })} />);

    expect(document.querySelector('[data-wb-content-skeleton]')).not.toBeNull();
    expect(
      document.querySelector('[data-wb-content-skeleton]')?.getAttribute('data-variant'),
    ).toBe('text');
    expect(panelProps).toHaveLength(1);

    const mappedOnTitle = panelProps[0].onTitleChange as (title: string) => void;
    act(() => {
      mappedOnTitle('我的笔记');
    });
    expect(onTitleChange).toHaveBeenCalledWith('我的笔记');
    expect(
      document.querySelector('[data-wb-content-skeleton]')?.getAttribute('data-phase'),
    ).toBe('fading');

    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(document.querySelector('[data-wb-content-skeleton]')).toBeNull();
    vi.useRealTimers();
  });

  it('uses pdf skeleton for textbook', () => {
    const TextbookWindow = createContentWindowComponent('textbook');
    render(<TextbookWindow {...makeWindowProps({ instanceKey: 'tb_1' })} />);
    expect(
      document.querySelector('[data-wb-content-skeleton]')?.getAttribute('data-variant'),
    ).toBe('pdf');
  });
});

describe('useContentLoadPhase', () => {
  afterEach(() => cleanup());

  it('dismisses immediately when role=alert appears', () => {
    const hostRef = { current: null as HTMLDivElement | null };

    const Probe: React.FC = () => {
      const { phase } = useContentLoadPhase({ hostRef, timeoutMs: 60_000 });
      return (
        <div
          ref={(el) => {
            hostRef.current = el;
          }}
          data-testid="host"
          data-phase={phase}
        >
          <div role="alert">load failed</div>
        </div>
      );
    };

    render(<Probe />);
    // MutationObserver / initial check should dismiss
    expect(screen.getByTestId('host').getAttribute('data-phase')).toBe('done');
  });
});
