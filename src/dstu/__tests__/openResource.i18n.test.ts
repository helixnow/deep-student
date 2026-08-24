/**
 * openResource 用户可见错误文案 i18n 契约测试
 *
 * 覆盖：
 * - reportError 动作名走 analysis:open_resource.action
 * - VfsError message 走 analysis:open_resource.*（含插值）
 * - defaultValue 与 zh-CN/analysis.json 主干原文一致
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import zhAnalysis from '@/locales/zh-CN/analysis.json';
import enAnalysis from '@/locales/en-US/analysis.json';

interface CapturedCall {
  key: string;
  options: Record<string, unknown> | undefined;
}

/** vi.mock 工厂被提升到 import 之前执行，共享状态必须走 vi.hoisted */
const harness = vi.hoisted(() => ({
  calls: [] as { key: string; options: Record<string, unknown> | undefined }[],
}));

function lookup(obj: Record<string, unknown>, dottedKey: string): unknown {
  return dottedKey.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as object)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

function interpolate(template: string, options: Record<string, unknown> | undefined): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(options?.[name] ?? `{{${name}}}`)
  );
}

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      harness.calls.push({ key, options });
      const bare = key.includes(':') ? key.split(':')[1] : key;
      const zh = lookup(zhAnalysis as unknown as Record<string, unknown>, bare);
      const template =
        typeof zh === 'string'
          ? zh
          : typeof options?.defaultValue === 'string'
            ? options.defaultValue
            : key;
      return interpolate(template, options);
    },
  },
}));

vi.mock('@/shared/result', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/result')>();
  return {
    ...actual,
    reportError: vi.fn(),
  };
});

vi.mock('../api', () => ({
  dstu: {
    get: vi.fn(),
  },
}));

import { openResource, registerOpenResourceHandler, type OpenResourceHandler } from '../openResource';
import { reportError } from '@/shared/result';
import { dstu } from '../api';
import type { DstuNode } from '../types';

const NAMESPACE = 'open-resource-i18n-test';

const noopHandler: OpenResourceHandler = {
  openInPanel: vi.fn(),
  openInPage: vi.fn(),
  openInFullscreen: vi.fn(),
  openInModal: vi.fn(),
};

function makeNode(overrides: Partial<DstuNode>): DstuNode {
  return {
    path: '/notes/demo.md',
    name: 'demo.md',
    type: 'note',
    ...overrides,
  } as DstuNode;
}

let unregister: (() => void) | null = null;

beforeEach(() => {
  harness.calls.length = 0;
  vi.mocked(reportError).mockClear();
  unregister = registerOpenResourceHandler(noopHandler, NAMESPACE);
});

afterEach(() => {
  unregister?.();
  unregister = null;
});

function lastReport(): { error: { message: string }; context: string } {
  const calls = vi.mocked(reportError).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [error, context] = calls[calls.length - 1];
  return { error: error as { message: string }, context: context as string };
}

describe('openResource i18n', () => {
  it('处理器未注册（无目标）→ handler_not_registered，动作名走 action key', async () => {
    const result = await openResource(makeNode({}), { handlerNamespace: 'no-such-namespace-registered' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('OpenResourceHandler 未注册: no-such-namespace-registered');
    }
    const { context } = lastReport();
    expect(context).toBe('打开资源');
  });

  it('文件夹节点 → folder_not_openable', async () => {
    const result = await openResource(makeNode({ type: 'folder' }), { handlerNamespace: NAMESPACE });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('文件夹不能在编辑器中打开');
    }
    const { context } = lastReport();
    expect(context).toBe('打开资源');
  });

  it('资源未找到 → not_found 带 path 插值', async () => {
    vi.mocked(dstu.get).mockResolvedValueOnce({ ok: true, value: null });

    const result = await openResource('/notes/missing.md', { handlerNamespace: NAMESPACE });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('资源未找到: /notes/missing.md');
    }
    const { context } = lastReport();
    expect(context).toBe('打开资源');
  });

  it('所有 analysis:open_resource key 的 defaultValue 与 zh-CN 主干原文一致', async () => {
    vi.mocked(dstu.get).mockResolvedValueOnce({ ok: true, value: null });
    await openResource(makeNode({}), { handlerNamespace: 'no-such-namespace-registered' });
    await openResource(makeNode({ type: 'folder' }), { handlerNamespace: NAMESPACE });
    await openResource('/notes/missing.md', { handlerNamespace: NAMESPACE });

    const openResourceCalls: CapturedCall[] = harness.calls.filter((call) =>
      call.key.startsWith('analysis:open_resource.')
    );
    expect(openResourceCalls.length).toBeGreaterThan(0);

    for (const call of openResourceCalls) {
      const bare = call.key.split(':')[1];
      const zhValue = lookup(zhAnalysis as unknown as Record<string, unknown>, bare);
      expect(typeof zhValue, `zh-CN 缺少 key: ${call.key}`).toBe('string');
      expect(call.options?.defaultValue, `defaultValue 应与 zh-CN 原文一致: ${call.key}`).toBe(zhValue);

      const enValue = lookup(enAnalysis as unknown as Record<string, unknown>, bare);
      expect(typeof enValue, `en-US 缺少 key: ${call.key}`).toBe('string');
    }
  });
});
