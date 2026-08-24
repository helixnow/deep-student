/**
 * prefers-reduced-motion：根节点 data-reduced-motion、chrome 流式指示、进度块静态化
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import React from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import {
  PREFERS_REDUCED_MOTION_QUERY,
  usePrefersReducedMotion,
} from '@/features/generative-ui/hooks/usePrefersReducedMotion';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析 AI 界面意图',
        parse_error_invalid: '格式无效',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中',
        'a11y.region_label': 'AI 生成界面',
        'a11y.progress_label': '进度',
        'a11y.text_label': '文本',
      };
      return map[key] ?? (params ? `${key}` : key);
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const PROGRESS_INTENT = {
  version: '1.1' as const,
  meta: { title: '进度' },
  blocks: [
    {
      type: 'progress' as const,
      props: { title: '复习', current: 3, total: 10, label: '3 / 10' },
    },
  ],
};

type MediaFlags = {
  reducedMotion?: boolean;
  compact?: boolean;
};

function mockMatchMedia({ reducedMotion = false, compact = false }: MediaFlags = {}): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        (String(query).includes('prefers-reduced-motion') && reducedMotion) ||
        (String(query).includes('max-width') && compact),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function mockInnerWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: width,
  });
}

function restoreDesktopMotion(): void {
  mockMatchMedia();
  mockInnerWidth(1280);
}

afterEach(() => {
  restoreDesktopMotion();
});

describe('usePrefersReducedMotion', () => {
  it('uses the shared prefers-reduced-motion query', () => {
    expect(PREFERS_REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });

  it('returns true when the reduced-motion media query matches', () => {
    mockInnerWidth(1280);
    mockMatchMedia({ reducedMotion: true });
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith(PREFERS_REDUCED_MOTION_QUERY);
  });

  it('returns false when the query does not match', () => {
    mockInnerWidth(1280);
    mockMatchMedia({ reducedMotion: false });
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });
});

describe('GenerativeUIRenderer reduced-motion root', () => {
  it('sets data-reduced-motion on the root and chrome when the query matches', () => {
    mockMatchMedia({ reducedMotion: true });
    mockInnerWidth(1280);
    const { container } = render(
      <GenerativeUIRenderer intent={PROGRESS_INTENT} isStreaming showChrome />,
    );

    const root = container.querySelector('[data-generative-ui]');
    expect(root).toHaveAttribute('data-reduced-motion', 'true');
    expect(root).not.toHaveAttribute('data-compact');

    const chrome = container.querySelector('[data-generative-ui-chrome]');
    expect(chrome).toHaveAttribute('data-reduced-motion', 'true');
    expect(chrome).toHaveAttribute('aria-busy', 'true');

    const indicator = container.querySelector('[data-stream-indicator]');
    expect(indicator).toBeTruthy();
    expect(indicator).toHaveAttribute('data-reduced-motion', 'true');
    expect(indicator).toHaveAttribute('aria-hidden');
    expect(indicator?.querySelectorAll('.generative-ui-stream-dot')).toHaveLength(3);

    const live = container.querySelector('[data-generative-ui-chrome] [aria-live="polite"]');
    expect(live).toHaveTextContent('生成中');

    const progress = container.querySelector('[data-generative-progress]');
    expect(progress).toHaveAttribute('data-reduced-motion', 'true');
    expect(container.querySelector('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '30');
  });

  it('does not set data-reduced-motion when motion is allowed', () => {
    mockMatchMedia({ reducedMotion: false });
    mockInnerWidth(1280);
    const { container } = render(
      <GenerativeUIRenderer intent={PROGRESS_INTENT} isStreaming showChrome />,
    );

    expect(container.querySelector('[data-generative-ui]')).not.toHaveAttribute('data-reduced-motion');
    expect(container.querySelector('[data-generative-ui-chrome]')).not.toHaveAttribute(
      'data-reduced-motion',
    );
    expect(container.querySelector('[data-stream-indicator]')).not.toHaveAttribute(
      'data-reduced-motion',
    );
    expect(container.querySelector('[data-generative-progress]')).not.toHaveAttribute(
      'data-reduced-motion',
    );
  });

  it('marks the streaming chrome-only fallback root', () => {
    mockMatchMedia({ reducedMotion: true });
    mockInnerWidth(1280);
    const { container } = render(
      <GenerativeUIRenderer intent="{ not-json" isStreaming showChrome />,
    );
    const root = container.querySelector('[data-generative-ui]');
    expect(root).toHaveAttribute('data-streaming');
    expect(root).toHaveAttribute('data-reduced-motion', 'true');
    expect(container.querySelector('[data-stream-indicator]')).toBeTruthy();
  });

  it('hides the stream indicator after streaming ends', () => {
    mockMatchMedia({ reducedMotion: true });
    mockInnerWidth(1280);
    const { container } = render(
      <GenerativeUIRenderer intent={PROGRESS_INTENT} isStreaming={false} showChrome />,
    );
    expect(container.querySelector('[data-stream-indicator]')).toBeNull();
    expect(container.querySelector('[data-generative-ui]')).toHaveAttribute(
      'data-reduced-motion',
      'true',
    );
  });
});

describe('reduced-motion source contracts', () => {
  it('CSS disables stream pulse and progress transitions', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'src/features/generative-ui/generative-ui.css'),
      'utf8',
    );
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('[data-reduced-motion]');
    expect(css).toContain('.generative-ui-stream-dot');
    expect(css).toContain('animation: none');
    expect(css).toContain('transition: none');
  });

  it('DESIGN_CONSTITUTION §8 requires prefers-reduced-motion', () => {
    const doc = fs.readFileSync(
      path.join(process.cwd(), 'docs/generative-ui/DESIGN_CONSTITUTION.md'),
      'utf8',
    );
    const section8 = doc.slice(doc.indexOf('## 8. Accessibility'));
    expect(section8).toContain('prefers-reduced-motion');
    expect(section8).toContain('data-reduced-motion');
    expect(section8).toContain('流式指示');
  });
});
