/**
 * multimodalRagService 空查询错误 i18n key-echo 测试
 *
 * mock `@/i18n` 让 t 原样回显 key，走公开入口（retrieve / retrieveDetailed /
 * searchByText）触发 buildLegacySearchInput 的空查询校验，断言：
 * - throw 的 message 就是 i18n key（证明错误文案走了 i18n 而非硬编码中文）；
 * - t 被以正确的 key + defaultValue（主干原文）调用；
 * - 校验失败时不会发起后端检索。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tMock, vfsMultimodalSearch, vfsMultimodalSearchDetailed } = vi.hoisted(() => ({
  tMock: vi.fn((key: string) => key),
  vfsMultimodalSearch: vi.fn(),
  vfsMultimodalSearchDetailed: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  default: { t: tMock },
}));

vi.mock('@/api/vfsRagApi', () => ({
  vfsMultimodalIndex: vi.fn(),
  vfsInspectRetrievalCapabilities: vi.fn(),
  vfsMultimodalSearch,
  vfsMultimodalSearchDetailed,
  vfsMultimodalStats: vi.fn(),
  vfsMultimodalDelete: vi.fn(),
  vfsMultimodalIndexResource: vi.fn(),
  parseRetrievalProvenance: vi.fn(() => []),
}));

import { retrieve, retrieveDetailed, searchByText } from '../multimodalRagService';

const EMPTY_QUERY_KEY = 'enhanced_rag:retrieve.empty_query';
const EMPTY_QUERY_FALLBACK = '检索请求必须包含文本、图片或两者';

describe('multimodalRagService empty-query error i18n', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retrieve rejects with the i18n key when both text and image are missing', async () => {
    await expect(retrieve()).rejects.toThrow(EMPTY_QUERY_KEY);

    expect(tMock).toHaveBeenCalledWith(EMPTY_QUERY_KEY, {
      defaultValue: EMPTY_QUERY_FALLBACK,
    });
    expect(vfsMultimodalSearch).not.toHaveBeenCalled();
  });

  it('retrieveDetailed rejects with the i18n key for a whitespace-only query', async () => {
    await expect(retrieveDetailed('   ')).rejects.toThrow(EMPTY_QUERY_KEY);

    expect(tMock).toHaveBeenCalledWith(EMPTY_QUERY_KEY, {
      defaultValue: EMPTY_QUERY_FALLBACK,
    });
    expect(vfsMultimodalSearchDetailed).not.toHaveBeenCalled();
  });

  it('searchByText rejects with the i18n key for an empty string', async () => {
    await expect(searchByText('')).rejects.toThrow(EMPTY_QUERY_KEY);

    expect(tMock).toHaveBeenCalledWith(EMPTY_QUERY_KEY, {
      defaultValue: EMPTY_QUERY_FALLBACK,
    });
    expect(vfsMultimodalSearch).not.toHaveBeenCalled();
  });
});
