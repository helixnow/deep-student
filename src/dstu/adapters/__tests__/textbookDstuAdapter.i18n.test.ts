/**
 * 教材 DSTU 适配器错误文案 i18n 契约测试
 *
 * 覆盖三层保障：
 * 1. locale 契约：zh-CN/en-US 的 card_manager.json 均含顶层 textbook 组，
 *    且 zh-CN 取值与主干原始中文文案逐字一致。
 * 2. source 守卫：textbookDstuAdapter.ts 中 reportError / toVfsError 的
 *    用户可见文案均经由 i18next.t('card_manager:textbook.*')，
 *    defaultValue 与 zh-CN locale 完全一致（异步 namespace 未就绪时兜底）。
 * 3. key-echo：mock i18next 后走真实失败路径，确认 reportError 的 context
 *    与 VfsError.message 确实来自 i18next.t 的返回值。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import zhCardManager from '@/locales/zh-CN/card_manager.json';
import enCardManager from '@/locales/en-US/card_manager.json';

const invokeMock = vi.fn();
const reportErrorMock = vi.fn();
const dstuListMock = vi.fn();
const dstuGetMock = vi.fn();
const dstuDeleteMock = vi.fn();
const dstuSetFavoriteMock = vi.fn();
const tMock = vi.fn(
  (key: string, options?: { defaultValue?: string }): string => {
    const bare = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    const value = bare.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object' && part in (acc as object)) {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, zhCardManager as Record<string, unknown>);
    if (typeof value === 'string') return value;
    return options?.defaultValue ?? key;
  },
);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../../api', () => ({
  dstu: {
    list: dstuListMock,
    get: dstuGetMock,
    delete: dstuDeleteMock,
    setFavorite: dstuSetFavoriteMock,
  },
}));

vi.mock('i18next', () => ({
  default: {
    t: tMock,
  },
}));

vi.mock('@/utils/fileManager', () => ({
  isOpaqueDocumentId: () => false,
  isGenericPlaceholderFileName: () => false,
}));

vi.mock('@/shared/result', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/result')>();
  return {
    ...actual,
    reportError: reportErrorMock,
  };
});

/** 主干原始中文文案（zh-CN locale 必须与之逐字一致） */
const EXPECTED_ZH_CN: Record<string, string> = {
  list: '列出教材',
  get_detail: '获取教材详情',
  delete: '删除教材',
  set_favorite: '设置收藏状态',
  add: '添加教材',
};

// jsdom 环境下 import.meta.url 非 file 协议，使用 vitest 根目录（项目根）解析
const adapterSourcePath = resolve(process.cwd(), 'src/dstu/adapters/textbookDstuAdapter.ts');
const adapterSource = readFileSync(adapterSourcePath, 'utf-8');

describe('textbookDstuAdapter 错误文案 i18n（card_manager:textbook）', async () => {
  // 动态导入以避免静态 import 触发 vi.mock 工厂对未初始化 mock 变量的提前访问
  const { err, VfsError, VfsErrorCode } = await import('@/shared/result');
  const { textbookDstuAdapter } = await import('../textbookDstuAdapter');

  beforeEach(() => {
    invokeMock.mockReset();
    reportErrorMock.mockReset();
    dstuListMock.mockReset();
    dstuGetMock.mockReset();
    dstuDeleteMock.mockReset();
    dstuSetFavoriteMock.mockReset();
    tMock.mockClear();
  });

  describe('locale 契约', () => {
    it('zh-CN 含顶层 textbook 组且取值与主干原文一致', () => {
      const group = (zhCardManager as Record<string, unknown>).textbook as Record<string, string>;
      expect(group).toBeTruthy();
      expect(group).toEqual(EXPECTED_ZH_CN);
    });

    it('en-US 含顶层 textbook 组，key 与 zh-CN 对齐且值非空、不含中文', () => {
      const group = (enCardManager as Record<string, unknown>).textbook as Record<string, string>;
      expect(group).toBeTruthy();
      expect(Object.keys(group).sort()).toEqual(Object.keys(EXPECTED_ZH_CN).sort());
      for (const [key, value] of Object.entries(group)) {
        expect(value, `en-US textbook.${key} 不应为空`).toBeTruthy();
        expect(value, `en-US textbook.${key} 不应含中文`).not.toMatch(/[\u4e00-\u9fff]/);
      }
    });
  });

  describe('source 守卫', () => {
    it('所有 reportError 调用的 context 均来自 i18next.t(card_manager:textbook.*)', () => {
      const totalCalls = adapterSource.match(/reportError\(/g) ?? [];
      expect(totalCalls.length).toBe(5);
      const i18nLabeled =
        adapterSource.match(
          /reportError\([^,\n]+,\s*(?:i18next\.t\('card_manager:textbook\.\w+'|context\b)/g
        ) ?? [];
      expect(i18nLabeled.length).toBe(totalCalls.length);
      // reportError / toVfsError 的第二参数不允许再出现裸字符串字面量
      expect(adapterSource).not.toMatch(/reportError\([^,\n]+,\s*'/);
      expect(adapterSource).not.toMatch(/toVfsError\([^,\n]+,\s*'/);
      // addTextbooks 失败路径：context 变量必须由 i18next.t(card_manager:textbook.add) 赋值
      expect(adapterSource).toMatch(
        /const context = i18next\.t\('card_manager:textbook\.add',\s*\{ defaultValue: '添加教材' \}\)/
      );
      expect(adapterSource).toMatch(/toVfsError\(error,\s*context\)/);
    });

    it('source 引用的每个 key 均存在于两种 locale，且 defaultValue 与 zh-CN 一致', () => {
      const zhGroup = (zhCardManager as Record<string, unknown>).textbook as Record<string, string>;
      const enGroup = (enCardManager as Record<string, unknown>).textbook as Record<string, string>;

      const pairs = [
        ...adapterSource.matchAll(
          /i18next\.t\('card_manager:textbook\.(\w+)',\s*\{ defaultValue: '([^']*)' \}\)/g
        ),
      ];
      const usedKeys = new Set(pairs.map(([, key]) => key));
      expect([...usedKeys].sort()).toEqual(Object.keys(EXPECTED_ZH_CN).sort());
      for (const [, key, defaultValue] of pairs) {
        expect(zhGroup[key], `zh-CN 缺少 textbook.${key}`).toBeTruthy();
        expect(enGroup[key], `en-US 缺少 textbook.${key}`).toBeTruthy();
        expect(defaultValue, `textbook.${key} 的 defaultValue 应与 zh-CN 一致`).toBe(zhGroup[key]);
      }
    });
  });

  describe('key-echo 失败路径（mock i18next）', () => {
    it('listTextbooks 失败时 reportError 的 context 来自 card_manager:textbook.list', async () => {
      const backendError = new VfsError(VfsErrorCode.NETWORK, 'backend boom', false);
      dstuListMock.mockResolvedValue(err(backendError));

      const result = await textbookDstuAdapter.listTextbooks();

      expect(result.ok).toBe(false);
      expect(tMock).toHaveBeenCalledWith('card_manager:textbook.list', {
        defaultValue: '列出教材',
      });
      expect(reportErrorMock).toHaveBeenCalledWith(backendError, '列出教材');
    });

    it('getTextbook / deleteTextbook / setFavorite 失败时各自使用对应 key', async () => {
      const backendError = new VfsError(VfsErrorCode.NETWORK, 'backend boom', false);
      dstuGetMock.mockResolvedValue(err(backendError));
      dstuDeleteMock.mockResolvedValue(err(backendError));
      dstuSetFavoriteMock.mockResolvedValue(err(backendError));

      await textbookDstuAdapter.getTextbook('tb-1');
      expect(tMock).toHaveBeenCalledWith('card_manager:textbook.get_detail', {
        defaultValue: '获取教材详情',
      });
      expect(reportErrorMock).toHaveBeenLastCalledWith(backendError, '获取教材详情');

      await textbookDstuAdapter.deleteTextbook('tb-1');
      expect(tMock).toHaveBeenCalledWith('card_manager:textbook.delete', {
        defaultValue: '删除教材',
      });
      expect(reportErrorMock).toHaveBeenLastCalledWith(backendError, '删除教材');

      await textbookDstuAdapter.setFavorite('tb-1', true);
      expect(tMock).toHaveBeenCalledWith('card_manager:textbook.set_favorite', {
        defaultValue: '设置收藏状态',
      });
      expect(reportErrorMock).toHaveBeenLastCalledWith(backendError, '设置收藏状态');
    });

    it('addTextbooks 失败时 toVfsError 兜底文案与 reportError context 来自 card_manager:textbook.add', async () => {
      // 非 Error 拒绝值会走 toVfsError 的 defaultMessage 分支
      invokeMock.mockRejectedValue(undefined);

      const result = await textbookDstuAdapter.addTextbooks(['/tmp/a.pdf']);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure result');

      expect(tMock).toHaveBeenCalledWith('card_manager:textbook.add', {
        defaultValue: '添加教材',
      });
      expect(result.error.message).toBe('添加教材');
      expect(reportErrorMock).toHaveBeenCalledWith(result.error, '添加教材');
    });

    it('addTextbooks 保留后端错误消息，不覆盖为兜底文案', async () => {
      invokeMock.mockRejectedValue(new Error('disk full'));

      const result = await textbookDstuAdapter.addTextbooks(['/tmp/a.pdf']);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure result');

      expect(result.error.message).toBe('disk full');
      expect(reportErrorMock).toHaveBeenCalledWith(result.error, '添加教材');
    });
  });
});
