/**
 * DSTU 列表加载与创建空资源错误标签 i18n 测试
 *
 * 验证 useDstuList / createEmpty 的用户可见 reportError 标签
 * 走 stats:dstu 命名空间，且 zh-CN / en-US 语言文件包含对应 key。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import zhStats from '@/locales/zh-CN/stats.json';
import enStats from '@/locales/en-US/stats.json';

vi.mock('@/i18n', async () => {
  const { default: zh } = await import('@/locales/zh-CN/stats.json');

  const lookup = (obj: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, obj);

  const t = (key: string, options?: Record<string, unknown>): string => {
    const [ns, bare] = key.includes(':')
      ? (key.split(':') as [string, string])
      : ['', key];
    const raw = ns === 'stats' ? lookup(zh, bare) : undefined;
    const template =
      typeof raw === 'string'
        ? raw
        : typeof options?.defaultValue === 'string'
          ? options.defaultValue
          : key;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
      String(options?.[name] ?? '')
    );
  };

  return { default: { t } };
});

vi.mock('@/shared/result', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/result')>();
  return {
    ...actual,
    reportError: vi.fn(),
  };
});

vi.mock('../api', () => ({
  dstu: {
    list: vi.fn(),
    create: vi.fn(),
  },
}));

import { dstu } from '../api';
import { ok, err, reportError, VfsError, VfsErrorCode } from '@/shared/result';
import { useDstuList } from '../hooks/useDstuList';
import { createEmpty, type CreatableResourceType } from '../factory';

const reportErrorMock = vi.mocked(reportError);
const listMock = vi.mocked(dstu.list);
const createMock = vi.mocked(dstu.create);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('locale files', () => {
  it('zh-CN stats.json 包含 dstu key，取值与主干原文一致', () => {
    expect(zhStats.dstu.load_list).toBe('加载列表');
    expect(zhStats.dstu.create_empty).toBe('创建空资源');
    expect(zhStats.dstu.unknown_resource_type).toBe('未知的资源类型: {{type}}');
  });

  it('en-US stats.json 包含对应的 dstu key', () => {
    expect(enStats.dstu.load_list).toBeTruthy();
    expect(enStats.dstu.create_empty).toBeTruthy();
    expect(enStats.dstu.unknown_resource_type).toContain('{{type}}');
  });
});

describe('useDstuList i18n', () => {
  it('列表加载失败时 reportError 使用 stats:dstu.load_list 的翻译', async () => {
    const listError = new VfsError(VfsErrorCode.VALIDATION, 'list failed');
    listMock.mockResolvedValue(err(listError));

    const { result } = renderHook(() => useDstuList('/'));

    await waitFor(() => {
      expect(result.current.error).toBe(listError);
    });

    expect(reportErrorMock).toHaveBeenCalledWith(listError, '加载列表');
  });
});

describe('createEmpty i18n', () => {
  it('未知资源类型时错误消息插值，reportError 使用 stats:dstu.create_empty 的翻译', async () => {
    const result = await createEmpty({ type: 'bogus' as CreatableResourceType });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('未知的资源类型: bogus');
      expect(result.error.code).toBe(VfsErrorCode.VALIDATION);
    }
    expect(reportErrorMock).toHaveBeenCalledWith(expect.any(VfsError), '创建空资源');
  });

  it('dstu.create 失败时 reportError 使用 stats:dstu.create_empty 的翻译', async () => {
    const createError = new VfsError(VfsErrorCode.VALIDATION, 'create failed');
    listMock.mockResolvedValue(ok([]));
    createMock.mockResolvedValue(err(createError));

    const result = await createEmpty({ type: 'note' });

    expect(result.ok).toBe(false);
    expect(reportErrorMock).toHaveBeenCalledWith(createError, '创建空资源');
  });
});
