/**
 * 窄屏 compact：matchMedia / innerWidth < sm → 单列 stack + data-compact
 * 间距 token 在 `.generative-ui-compact` / generative-ui.css（仅 4/8/12）
 * 桌面端保持 v1.1 sm:grid-cols-* token
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import React from 'react';
import { BREAKPOINTS, getMediaQuery } from '@/config/breakpoints';
import {
  layoutGridClassName,
  layoutSpanClassName,
} from '@/features/generative-ui/schema';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import {
  GENERATIVE_UI_COMPACT_CLASS,
  GENERATIVE_UI_COMPACT_MAX_WIDTH,
  GENERATIVE_UI_COMPACT_MEDIA_QUERY,
  isGenerativeUICompactViewport,
  useGenerativeUICompact,
} from '@/features/generative-ui/hooks/useGenerativeUICompact';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析 AI 界面意图',
        parse_error_invalid: '格式无效',
        unknown_block_title: `未知组件：${params?.type ?? ''}`,
        unknown_block_desc: '已跳过',
        validation_failed_title: '校验失败',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中',
        'a11y.region_label': 'AI 生成界面',
        'a11y.text_label': '文本',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const V11_GRID_DOC = {
  version: '1.1' as const,
  layout: { mode: 'grid' as const, columns: 2 as const },
  meta: { title: 'v1.1 grid' },
  blocks: [
    { type: 'text', props: { body: 'wide' }, span: 2 as const },
    { type: 'stat-card', props: { title: 'Due', value: 3 } },
  ],
};

function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
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

function restoreDesktopViewport(): void {
  mockMatchMedia(false);
  mockInnerWidth(1280);
}

afterEach(() => {
  restoreDesktopViewport();
});

describe('isGenerativeUICompactViewport', () => {
  it('is true when matchMedia matches, even if width is desktop', () => {
    expect(isGenerativeUICompactViewport(1280, true)).toBe(true);
  });

  it('is true when window width is below sm, even if matchMedia is false', () => {
    expect(isGenerativeUICompactViewport(390, false)).toBe(true);
    expect(isGenerativeUICompactViewport(BREAKPOINTS.sm - 1, false)).toBe(true);
  });

  it('is false on desktop (width >= sm and media false)', () => {
    expect(isGenerativeUICompactViewport(BREAKPOINTS.sm, false)).toBe(false);
    expect(isGenerativeUICompactViewport(1280, false)).toBe(false);
  });
});

describe('useGenerativeUICompact', () => {
  it('uses the shared sm max media query', () => {
    expect(GENERATIVE_UI_COMPACT_MAX_WIDTH).toBe(BREAKPOINTS.sm);
    expect(GENERATIVE_UI_COMPACT_MEDIA_QUERY).toBe(getMediaQuery('sm', 'max'));
    expect(GENERATIVE_UI_COMPACT_MEDIA_QUERY).toBe('(max-width: 639px)');
  });

  it('returns true when matchMedia matches the sm query', () => {
    mockInnerWidth(1280);
    mockMatchMedia(true);
    const { result } = renderHook(() => useGenerativeUICompact());
    expect(result.current).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith(GENERATIVE_UI_COMPACT_MEDIA_QUERY);
  });

  it('returns true when innerWidth is below sm even if matchMedia is false', () => {
    mockMatchMedia(false);
    mockInnerWidth(375);
    const { result } = renderHook(() => useGenerativeUICompact());
    expect(result.current).toBe(true);
  });

  it('returns false on desktop viewport', () => {
    mockMatchMedia(false);
    mockInnerWidth(1280);
    const { result } = renderHook(() => useGenerativeUICompact());
    expect(result.current).toBe(false);
  });
});

describe('layout helpers compact', () => {
  it('forces single-column gap-2 and drops span tokens', () => {
    expect(layoutGridClassName('grid', 2, true)).toBe('grid gap-2');
    expect(layoutGridClassName('grid', 3, true)).toBe('grid gap-2');
    expect(layoutGridClassName('stack', 1, true)).toBe('grid gap-2');
    expect(layoutSpanClassName('grid', 2, true)).toBeUndefined();
    expect(layoutSpanClassName('grid', 3, true)).toBeUndefined();
  });

  it('keeps v1.1 desktop tokens when compact is omitted / false', () => {
    expect(layoutGridClassName('grid', 2)).toBe('grid gap-3 sm:grid-cols-2');
    expect(layoutGridClassName('grid', 3)).toBe('grid gap-3 sm:grid-cols-3');
    expect(layoutGridClassName('grid', 2, false)).toBe('grid gap-3 sm:grid-cols-2');
    expect(layoutSpanClassName('grid', 2)).toBe('sm:col-span-2');
    expect(layoutSpanClassName('grid', 3)).toBe('sm:col-span-3');
  });
});

describe('GenerativeUIRenderer compact root', () => {
  it('sets data-compact + compact class and stacks v1.1 grid to one column', () => {
    mockMatchMedia(true);
    mockInnerWidth(390);
    const { container } = render(
      <GenerativeUIRenderer intent={V11_GRID_DOC} showChrome={false} />,
    );

    const root = container.querySelector('[data-generative-ui]');
    expect(root).toHaveAttribute('data-compact', 'true');
    expect(root?.className).toContain(GENERATIVE_UI_COMPACT_CLASS);
    expect(root?.className).not.toContain('space-y-2');
    expect(root?.className).not.toContain('space-y-3');

    const layout = container.querySelector('[data-layout-mode="grid"]');
    expect(layout).toBeTruthy();
    expect(layout).toHaveAttribute('data-layout-columns', '2');
    expect(layout?.className).toBe('grid gap-2');
    expect(layout?.className).not.toContain('sm:grid-cols-2');
    expect(container.textContent).toContain('wide');
    expect(container.textContent).toContain('Due');
  });

  it('does not set compact on desktop and keeps v1.1 grid tokens', () => {
    mockMatchMedia(false);
    mockInnerWidth(1280);
    const { container } = render(
      <GenerativeUIRenderer intent={V11_GRID_DOC} showChrome={false} />,
    );

    const root = container.querySelector('[data-generative-ui]');
    expect(root).not.toHaveAttribute('data-compact');
    expect(root?.className).not.toContain(GENERATIVE_UI_COMPACT_CLASS);
    expect(root?.className).toContain('space-y-3');

    const layout = container.querySelector('[data-layout-mode="grid"]');
    expect(layout).toHaveAttribute('data-layout-columns', '2');
    expect(layout?.className).toContain('grid gap-3');
    expect(layout?.className).toContain('sm:grid-cols-2');
    expect(container.querySelector('[data-layout-span="2"]')?.className).toContain('sm:col-span-2');
  });

  it('marks streaming chrome-only root as compact on narrow viewports', () => {
    mockMatchMedia(true);
    mockInnerWidth(390);
    const { container } = render(
      <GenerativeUIRenderer intent="{ not-json" isStreaming showChrome={false} />,
    );
    const root = container.querySelector('[data-generative-ui]');
    expect(root).toHaveAttribute('data-streaming');
    expect(root).toHaveAttribute('data-compact', 'true');
    expect(root?.className).toContain(GENERATIVE_UI_COMPACT_CLASS);
  });
});

describe('generative-ui compact CSS token contract', () => {
  const cssPath = path.join(process.cwd(), 'src/features/generative-ui/generative-ui.css');

  it('ships generative-ui.css with .generative-ui-compact 4/8/12 tokens', () => {
    expect(fs.existsSync(cssPath)).toBe(true);
    const css = fs.readFileSync(cssPath, 'utf8');
    expect(css).toContain('.generative-ui-compact');
    expect(css).toMatch(/--generative-ui-space-1:\s*4px/);
    expect(css).toMatch(/--generative-ui-space-2:\s*8px/);
    expect(css).toMatch(/--generative-ui-space-3:\s*12px/);
    const compactRules = [...css.matchAll(/\.generative-ui-compact[^{]*\{[^}]+\}/g)]
      .map((m) => m[0])
      .join('\n');
    expect(compactRules.length).toBeGreaterThan(0);
    expect(compactRules).not.toMatch(/16px|24px/);
  });

  it('maps compact via class only (spacing lives in CSS, not temporary utilities)', () => {
    const rendererSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/features/generative-ui/GenerativeUIRenderer.tsx'),
      'utf8',
    );
    expect(rendererSrc).toContain("import './generative-ui.css'");
    expect(rendererSrc).toContain('GENERATIVE_UI_COMPACT_CLASS');
    expect(rendererSrc).not.toContain('space-y-2');
    expect(rendererSrc).not.toContain('[&_[data-block-type]>div]:p-2');
  });

  it('documents .generative-ui-compact in DESIGN_CONSTITUTION spacing section', () => {
    const constitution = fs.readFileSync(
      path.join(process.cwd(), 'docs/generative-ui/DESIGN_CONSTITUTION.md'),
      'utf8',
    );
    const spacingSection = constitution.split('## 3.')[0];
    expect(spacingSection).toContain('## 2. 间距');
    expect(spacingSection).toContain('.generative-ui-compact');
    expect(spacingSection).toContain('generative-ui.css');
  });

  it('keeps [data-generative-ui] :focus-visible ring token in the same stylesheet', () => {
    const css = fs.readFileSync(cssPath, 'utf8');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('--ring');
    expect(css).toMatch(/hsl\(\s*var\(\s*--ring\s*\)\s*\)/);
    expect(css).not.toMatch(/:focus-visible[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/);
  });
});
