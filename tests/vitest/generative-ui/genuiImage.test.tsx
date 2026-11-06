/**
 * WP-E：image 来源解析 / 预算 / hook（resource 嗅探、svg 拒绝、>10MB 拒绝、pdf-page 0 基、https 规则、25MB 预算）
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

import {
  GENUI_IMAGE_BUDGET_BYTES,
  GENUI_IMAGE_CACHE_MAX_ENTRIES,
  GENUI_IMAGE_MAX_BYTES,
  GenerativeImageBudget,
  clearGenerativeImageCache,
  getGenerativeImageCacheKeys,
  resolveGenerativeImage,
  sniffGenerativeImageMime,
  type ResolveGenerativeImageDeps,
} from '@/features/generative-ui/media/resolveGenerativeImage';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10];
const GIF_BYTES = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0];
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}
const SVG_B64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function makeDeps(overrides: Partial<ResolveGenerativeImageDeps> = {}): ResolveGenerativeImageDeps {
  return {
    invoke: vi.fn(async () => ({ found: true, content: b64(PNG_BYTES) })),
    getPdfPageImage: vi.fn(async () => ({ base64: b64(PNG_BYTES), mimeType: 'image/png', size: PNG_BYTES.length })),
    ...overrides,
  };
}

beforeEach(() => {
  clearGenerativeImageCache();
  invokeMock.mockReset();
});

describe('sniffGenerativeImageMime', () => {
  it('recognizes png / jpeg / gif / webp only', () => {
    expect(sniffGenerativeImageMime(new Uint8Array(PNG_BYTES))).toBe('image/png');
    expect(sniffGenerativeImageMime(new Uint8Array(JPEG_BYTES))).toBe('image/jpeg');
    expect(sniffGenerativeImageMime(new Uint8Array(GIF_BYTES))).toBe('image/gif');
    expect(sniffGenerativeImageMime(new Uint8Array(WEBP_BYTES))).toBe('image/webp');
    expect(sniffGenerativeImageMime(new TextEncoder().encode('<svg></svg>'))).toBeNull();
    expect(sniffGenerativeImageMime(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
  });
});

describe('resolveGenerativeImage — resource', () => {
  it('invokes vfs_get_attachment_content with 10MB cap and sniffs MIME (ignores declared type)', async () => {
    const deps = makeDeps({ invoke: vi.fn(async () => ({ found: true, content: b64(JPEG_BYTES) })) });
    const result = await resolveGenerativeImage({ kind: 'resource', resourceId: 'att_abc' }, deps);
    expect(deps.invoke).toHaveBeenCalledWith('vfs_get_attachment_content', {
      attachmentId: 'att_abc',
      maxBytes: GENUI_IMAGE_MAX_BYTES,
    });
    expect(result).toMatchObject({ ok: true, kind: 'blob', mime: 'image/jpeg', bytes: JPEG_BYTES.length });
  });

  it('rejects svg content', async () => {
    const deps = makeDeps({ invoke: vi.fn(async () => ({ found: true, content: SVG_B64 })) });
    const result = await resolveGenerativeImage({ kind: 'resource', resourceId: 'img_svg' }, deps);
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_type' });
  });

  it('rejects content larger than 10MB without decoding', async () => {
    const huge = 'A'.repeat(14_000_000);
    const deps = makeDeps({ invoke: vi.fn(async () => ({ found: true, content: huge })) });
    const result = await resolveGenerativeImage({ kind: 'resource', resourceId: 'file_big' }, deps);
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('maps found=false to not_found and invoke errors to load_failed', async () => {
    const missing = await resolveGenerativeImage(
      { kind: 'resource', resourceId: 'res_missing' },
      makeDeps({ invoke: vi.fn(async () => ({ found: false, content: null })) }),
    );
    expect(missing).toMatchObject({ ok: false, reason: 'not_found' });
    const failed = await resolveGenerativeImage(
      { kind: 'resource', resourceId: 'res_err' },
      makeDeps({ invoke: vi.fn(async () => { throw new Error('boom'); }) }),
    );
    expect(failed).toMatchObject({ ok: false, reason: 'load_failed' });
  });

  it('rejects resource ids outside the allowed prefixes before any IPC', async () => {
    const deps = makeDeps();
    const result = await resolveGenerativeImage({ kind: 'resource', resourceId: 'tb_x' }, deps);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_source' });
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it('caches decoded blobs (LRU, max 32) and dedupes in-flight requests', async () => {
    const deps = makeDeps();
    await Promise.all([
      resolveGenerativeImage({ kind: 'resource', resourceId: 'att_same' }, deps),
      resolveGenerativeImage({ kind: 'resource', resourceId: 'att_same' }, deps),
    ]);
    await resolveGenerativeImage({ kind: 'resource', resourceId: 'att_same' }, deps);
    expect(deps.invoke).toHaveBeenCalledTimes(1);

    for (let i = 0; i < GENUI_IMAGE_CACHE_MAX_ENTRIES + 3; i += 1) {
      await resolveGenerativeImage({ kind: 'resource', resourceId: `att_n${i}` }, deps);
    }
    const keys = getGenerativeImageCacheKeys();
    expect(keys).toHaveLength(GENUI_IMAGE_CACHE_MAX_ENTRIES);
    expect(keys).not.toContain('resource:att_same');
    expect(keys.at(-1)).toBe(`resource:att_n${GENUI_IMAGE_CACHE_MAX_ENTRIES + 2}`);
  });
});

describe('resolveGenerativeImage — pdf-page', () => {
  it('converts 1-based page to 0-based pageIndex', async () => {
    const deps = makeDeps();
    const result = await resolveGenerativeImage({ kind: 'pdf-page', resourceId: 'res_pdf', page: 3 }, deps);
    expect(deps.getPdfPageImage).toHaveBeenCalledWith('res_pdf', 2);
    expect(result).toMatchObject({ ok: true, kind: 'blob', mime: 'image/png' });
  });

  it('rejects size > 10MB and non-whitelisted MIME', async () => {
    const big = await resolveGenerativeImage(
      { kind: 'pdf-page', resourceId: 'res_big', page: 1 },
      makeDeps({ getPdfPageImage: vi.fn(async () => ({ base64: b64(PNG_BYTES), mimeType: 'image/png', size: GENUI_IMAGE_MAX_BYTES + 1 })) }),
    );
    expect(big).toMatchObject({ ok: false, reason: 'too_large' });
    const svg = await resolveGenerativeImage(
      { kind: 'pdf-page', resourceId: 'res_svg', page: 1 },
      makeDeps({ getPdfPageImage: vi.fn(async () => ({ base64: SVG_B64, mimeType: 'image/svg+xml', size: 10 })) }),
    );
    expect(svg).toMatchObject({ ok: false, reason: 'unsupported_type' });
  });
});

describe('resolveGenerativeImage — url', () => {
  it('accepts public https without fetching', async () => {
    const deps = makeDeps();
    const result = await resolveGenerativeImage({ kind: 'url', url: 'https://example.com/a.png' }, deps);
    expect(result).toMatchObject({ ok: true, kind: 'url', src: 'https://example.com/a.png' });
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it.each([
    'http://example.com/a.png',
    'https://127.0.0.1/a.png',
    'https://192.168.1.10/a.png',
    'https://[::1]/a.png',
    'https://localhost/a.png',
    'https://intranet/a.png',
    'https://user:pass@example.com/a.png',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ])('rejects %s', async (url) => {
    const result = await resolveGenerativeImage({ kind: 'url', url }, makeDeps());
    expect(result).toMatchObject({ ok: false, reason: 'invalid_source' });
  });
});

describe('GenerativeImageBudget', () => {
  it('enforces the 25MB total and counts a shared key once', () => {
    const budget = new GenerativeImageBudget();
    expect(budget.limitBytes).toBe(GENUI_IMAGE_BUDGET_BYTES);
    const tenMb = 10 * 1024 * 1024;
    expect(budget.tryReserve('a', 'h1', tenMb)).toBe(true);
    expect(budget.tryReserve('b', 'h2', tenMb)).toBe(true);
    expect(budget.tryReserve('a', 'h3', tenMb)).toBe(true); // 同 key 不重复计数
    expect(budget.used).toBe(2 * tenMb);
    expect(budget.tryReserve('c', 'h4', tenMb)).toBe(false);
    budget.release('a', 'h1');
    expect(budget.used).toBe(2 * tenMb); // h3 仍持有
    budget.release('a', 'h3');
    expect(budget.tryReserve('c', 'h4', tenMb)).toBe(true);
  });
});

describe('ImageBlock in renderer', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const createSpy = vi.fn(() => 'blob:mock-1');
  const revokeSpy = vi.fn();

  beforeEach(() => {
    createSpy.mockClear();
    revokeSpy.mockClear();
    URL.createObjectURL = createSpy as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeSpy as unknown as typeof URL.revokeObjectURL;
  });
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  const intent = {
    version: '1.1' as const,
    blocks: [
      { type: 'image', props: { source: { kind: 'resource', resourceId: 'img_demo' }, alt: '示意图', caption: '图注' } },
    ],
  };

  it('does not request while streaming', () => {
    invokeMock.mockResolvedValue({ found: true, content: b64(PNG_BYTES) });
    const { container } = render(<GenerativeUIRenderer intent={intent} isStreaming showChrome={false} />);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-generative-image-state="loading"]')).not.toBeNull();
  });

  it('loads resource as Blob URL with safe img attributes and revokes on unmount', async () => {
    invokeMock.mockResolvedValue({ found: true, content: b64(PNG_BYTES) });
    const { unmount } = render(<GenerativeUIRenderer intent={intent} showChrome={false} />);
    const img = await screen.findByRole('img', { name: '示意图' });
    expect(img).toHaveAttribute('src', 'blob:mock-1');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(screen.getByText('图注')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    unmount();
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-1');
  });

  it('shows alt + unavailable on failure', async () => {
    invokeMock.mockResolvedValue({ found: true, content: SVG_B64 });
    const { container } = render(<GenerativeUIRenderer intent={intent} showChrome={false} />);
    await waitFor(() =>
      expect(container.querySelector('[data-generative-image-state="error"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-generative-image-reason="unsupported_type"]')).not.toBeNull();
    expect(screen.getByText('示意图')).toBeInTheDocument();
    expect(screen.getByText('image.unavailable')).toBeInTheDocument();
  });
});
