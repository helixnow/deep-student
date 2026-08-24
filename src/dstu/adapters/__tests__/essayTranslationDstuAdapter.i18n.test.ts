/**
 * essayDstuAdapter / translationDstuAdapter 错误上下文 i18n 契约
 *
 * - reportError / toVfsError 的上下文走 app_menu:dstu_essay.* / app_menu:dstu_translation.* key，
 *   defaultValue 兜底为主干英文原文（namespace 异步加载窗口期不回退成裸 key）。
 * - key-echo mock：断言与语言无关；真实文案由 app_menu.json 的 zh-CN / en-US 提供。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enAppMenu from '@/locales/en-US/app_menu.json';
import zhAppMenu from '@/locales/zh-CN/app_menu.json';

const { tSpy, reportErrorSpy, dstuMock } = vi.hoisted(() => ({
  tSpy: vi.fn((key: string) => key),
  reportErrorSpy: vi.fn(),
  dstuMock: {
    list: vi.fn(),
    get: vi.fn(),
    getContent: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setFavorite: vi.fn(),
    setMetadata: vi.fn(),
  },
}));

vi.mock('i18next', () => ({ default: { t: tSpy } }));

vi.mock('../../api', () => ({ dstu: dstuMock }));

vi.mock('@/shared/result', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/result')>();
  return { ...actual, reportError: reportErrorSpy };
});

vi.mock('@/essay-grading/essayGradingApi', () => ({
  EssayGradingAPI: {
    getSession: vi.fn(),
    getRounds: vi.fn(),
    createSession: vi.fn(),
  },
  canonicalizeEssayModeId: (id: string) => id,
}));

import { VfsError, VfsErrorCode, err } from '@/shared/result';
import { EssayGradingAPI } from '@/essay-grading/essayGradingApi';
import { essayDstuAdapter } from '../essayDstuAdapter';
import { translationDstuAdapter, type TranslationSession } from '../translationDstuAdapter';

/** 主干英文原文（= 代码中的 defaultValue，= en-US locale 文案） */
const EXPECTED_EN: Record<'dstu_essay' | 'dstu_translation', Record<string, string>> = {
  dstu_essay: {
    list_sessions: 'List essay grading sessions',
    get_session_detail: 'Get essay session detail',
    delete_session: 'Delete essay session',
    get_session: 'Get essay session',
    toggle_favorite: 'Toggle favorite',
    set_favorite: 'Set favorite',
    get_full_session: 'Get full essay session',
    create_session: 'Create essay session',
    update_session_metadata: 'Update session metadata',
  },
  dstu_translation: {
    list_history: 'List translation history',
    get_detail: 'Get translation detail',
    delete_translation: 'Delete translation',
    get_translation: 'Get translation',
    toggle_favorite: 'Toggle favorite',
    set_favorite: 'Set favorite',
    create_record: 'Create translation record',
    persist_settings: 'Persist translation settings',
    update_record: 'Update translation record',
  },
};

function makeError(): VfsError {
  return new VfsError(VfsErrorCode.NETWORK, 'boom');
}

beforeEach(() => {
  tSpy.mockClear();
  reportErrorSpy.mockClear();
  Object.values(dstuMock).forEach((fn) => fn.mockReset());
});

describe('app_menu locale 契约 — dstu_essay / dstu_translation', () => {
  it('en-US 顶层组与主干英文原文一致', () => {
    expect((enAppMenu as Record<string, unknown>).dstu_essay).toEqual(EXPECTED_EN.dstu_essay);
    expect((enAppMenu as Record<string, unknown>).dstu_translation).toEqual(
      EXPECTED_EN.dstu_translation,
    );
  });

  it('zh-CN 与 en-US key 集合一致且均为非空中文文案', () => {
    for (const group of ['dstu_essay', 'dstu_translation'] as const) {
      const zhGroup = (zhAppMenu as Record<string, unknown>)[group] as Record<string, string>;
      expect(Object.keys(zhGroup).sort()).toEqual(Object.keys(EXPECTED_EN[group]).sort());
      for (const value of Object.values(zhGroup)) {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
        expect(value).toMatch(/[\u4e00-\u9fff]/);
      }
    }
  });
});

describe('essayDstuAdapter — reportError / toVfsError 上下文走 app_menu:dstu_essay.*', () => {
  it('listEssays 失败 → list_sessions（defaultValue = 英文原文）', async () => {
    const error = makeError();
    dstuMock.list.mockResolvedValue(err(error));

    const result = await essayDstuAdapter.listEssays();

    expect(result.ok).toBe(false);
    expect(reportErrorSpy).toHaveBeenCalledWith(error, 'app_menu:dstu_essay.list_sessions');
    expect(tSpy).toHaveBeenCalledWith('app_menu:dstu_essay.list_sessions', {
      defaultValue: 'List essay grading sessions',
    });
  });

  it('deleteEssay 失败 → delete_session', async () => {
    const error = makeError();
    dstuMock.delete.mockResolvedValue(err(error));

    await essayDstuAdapter.deleteEssay('s1');

    expect(reportErrorSpy).toHaveBeenCalledWith(error, 'app_menu:dstu_essay.delete_session');
    expect(tSpy).toHaveBeenCalledWith('app_menu:dstu_essay.delete_session', {
      defaultValue: 'Delete essay session',
    });
  });

  it('createSession 抛错 → toVfsError 上下文 create_session', async () => {
    vi.mocked(EssayGradingAPI.createSession).mockRejectedValue(null);

    const result = await essayDstuAdapter.createSession({
      title: 't',
      essayType: 'narrative',
      gradeLevel: 'g1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 非 Error/字符串错误 → VfsError.message 采用 defaultMessage（key-echo 即 key）
      expect(result.error.message).toBe('app_menu:dstu_essay.create_session');
    }
    expect(tSpy).toHaveBeenCalledWith('app_menu:dstu_essay.create_session', {
      defaultValue: 'Create essay session',
    });
  });
});

describe('translationDstuAdapter — reportError 上下文走 app_menu:dstu_translation.*', () => {
  it('listTranslations 失败 → list_history（defaultValue = 英文原文）', async () => {
    const error = makeError();
    dstuMock.list.mockResolvedValue(err(error));

    const result = await translationDstuAdapter.listTranslations();

    expect(result.ok).toBe(false);
    expect(reportErrorSpy).toHaveBeenCalledWith(error, 'app_menu:dstu_translation.list_history');
    expect(tSpy).toHaveBeenCalledWith('app_menu:dstu_translation.list_history', {
      defaultValue: 'List translation history',
    });
  });

  it('updateTranslation 正文补写失败 → persist_settings', async () => {
    const error = makeError();
    dstuMock.setMetadata.mockResolvedValue({ ok: true, value: undefined });
    dstuMock.update.mockResolvedValue(err(error));

    const session: TranslationSession = {
      id: 'tr_1',
      sourceText: 'hello',
      translatedText: '你好',
      srcLang: 'en',
      tgtLang: 'zh-CN',
      formality: 'auto',
      createdAt: 0,
      updatedAt: 0,
    };
    const result = await translationDstuAdapter.updateTranslation(session);

    expect(result.ok).toBe(false);
    expect(reportErrorSpy).toHaveBeenCalledWith(
      error,
      'app_menu:dstu_translation.persist_settings',
    );
    expect(tSpy).toHaveBeenCalledWith('app_menu:dstu_translation.persist_settings', {
      defaultValue: 'Persist translation settings',
    });
  });

  it('setFavorite 失败 → set_favorite', async () => {
    const error = makeError();
    dstuMock.setFavorite.mockResolvedValue(err(error));

    await translationDstuAdapter.setFavorite('tr_1', true);

    expect(reportErrorSpy).toHaveBeenCalledWith(error, 'app_menu:dstu_translation.set_favorite');
    expect(tSpy).toHaveBeenCalledWith('app_menu:dstu_translation.set_favorite', {
      defaultValue: 'Set favorite',
    });
  });
});
