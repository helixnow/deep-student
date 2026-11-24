import { describe, expect, it } from 'vitest';
import enSettings from '@/locales/en-US/settings.json';
import zhSettings from '@/locales/zh-CN/settings.json';
import {
  getModelDisplayLabel,
  getProviderDisplayName,
  getVendorDisplayName,
  getVendorNotesDisplay,
  type VendorTranslateFn,
} from '../builtinVendorDisplay';

function makeTranslator(locale: Record<string, unknown>): VendorTranslateFn {
  return (key: string, options?: { defaultValue?: string }) => {
    const bare = key.startsWith('settings:') ? key.slice('settings:'.length) : key;
    let cur: unknown = locale;
    for (const part of bare.split('.')) {
      if (!cur || typeof cur !== 'object') {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === 'string' ? cur : (options?.defaultValue ?? key);
  };
}

describe('builtinVendorDisplay (W8B-11)', () => {
  const tEn = makeTranslator(enSettings as Record<string, unknown>);
  const tZh = makeTranslator(zhSettings as Record<string, unknown>);
  const cjk = /[\u4e00-\u9fff]/;

  it('renders English vendor names and notes in en-US even for legacy Chinese persisted rows', () => {
    const legacyVendors = [
      {
        id: 'builtin-qwen',
        name: '通义千问',
        providerType: 'qwen',
        isBuiltin: true,
        notes:
          '阿里云百炼 API（兼容 OpenAI Chat；平台亦支持 Responses / DashScope 原生）。推荐模型: qwen3.7-max(旗舰), qwen3.7-plus(官方默认推荐/多模态), qwen3.6-flash, qwen3.5-plus, qwen3.5-flash, qwen3-max, qwen3.5-397b-a17b, qwen3.5-122b-a10b',
        expectedName: 'Alibaba Qwen',
      },
      {
        id: 'builtin-zhipu',
        name: '智谱AI',
        providerType: 'zhipu',
        isBuiltin: true,
        notes:
          '智谱AI 开放平台。可用模型: glm-5.2(当前旗舰, 1M 上下文, 支持 reasoning_effort), glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4.7-flash(免费)',
        expectedName: 'Zhipu AI',
      },
      {
        id: 'builtin-doubao',
        name: '字节豆包',
        providerType: 'doubao',
        isBuiltin: true,
        notes:
          '火山方舟大模型平台。推荐模型: doubao-seed-2-1-pro-260628 / doubao-seed-2-1-turbo-260628 (2.1 旗舰, 256K 上下文), doubao-seed-evolving (滚动更新 ID), Seed 2.0 全系, Seed 1.8 (doubao-seed-1-8-251228)。可直接用模型名或 ep-* 接入点调用。',
        expectedName: 'ByteDance Doubao',
      },
      {
        id: 'builtin-moonshot',
        name: '月之暗面',
        providerType: 'moonshot',
        isBuiltin: true,
        notes:
          'Kimi API。可用模型: kimi-k3(1M/多模态/强制最高推理), kimi-k2.6(多模态), kimi-k2.7-code(编程/强制思考), kimi-k2.5(多模态), moonshot-v1 系列。kimi-k2 全系与 kimi-k2-thinking 已于 2026-05-25 停服、kimi-latest 已于 2026-01-28 停服。注意: K3 不接受 K2.x thinking 对象；K2.5/K2.6 采样参数锁定。',
        expectedName: 'Moonshot AI',
      },
      {
        id: 'builtin-gemini',
        name: 'Google Gemini',
        providerType: 'gemini',
        isBuiltin: true,
        notes:
          'Google Gemini API (原生模式)。推荐模型: gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.1-pro-preview, gemini-3.1-flash-lite；gemini-2.5-pro/flash/flash-lite 于 2026-10-16 关停前仍可用。3.x 模型官方不建议自定义采样参数。启用 thinking / systemInstruction / thoughtSignature 相关能力时建议走 v1beta。',
        expectedName: 'Google Gemini',
      },
    ];

    for (const v of legacyVendors) {
      const providerLabel = getProviderDisplayName(v.providerType, tEn);
      const displayName = getVendorDisplayName(v, providerLabel, tEn);
      const displayNotes = getVendorNotesDisplay(v, tEn);
      expect(displayName).toBe(v.expectedName);
      expect(cjk.test(displayName)).toBe(false);
      expect(displayNotes.length).toBeGreaterThan(10);
      expect(cjk.test(displayNotes)).toBe(false);
    }
  });

  it('preserves Chinese vendor names and notes in zh-CN for canonical English catalog rows', () => {
    const qwenEn = {
      id: 'builtin-qwen',
      name: 'Alibaba Qwen',
      providerType: 'qwen',
      isBuiltin: true,
      notes:
        'Alibaba Cloud Model Studio (Bailian) API (OpenAI Chat compatible; also supports Responses and native DashScope). Recommended models: qwen3.7-max (flagship), qwen3.7-plus (default recommended / multimodal), qwen3.6-flash, qwen3.5-plus, qwen3.5-flash, qwen3-max, qwen3.5-397b-a17b, qwen3.5-122b-a10b.',
    };
    const providerLabel = getProviderDisplayName(qwenEn.providerType, tZh);
    expect(getVendorDisplayName(qwenEn, providerLabel, tZh)).toBe('通义千问');
    expect(getVendorNotesDisplay(qwenEn, tZh)).toContain('阿里云百炼');

    const moonshotEn = {
      id: 'builtin-moonshot',
      name: 'Moonshot AI',
      providerType: 'moonshot',
      isBuiltin: true,
      notes: '',
    };
    expect(getVendorDisplayName(moonshotEn, getProviderDisplayName('moonshot', tZh), tZh)).toBe('月之暗面');
  });

  it('keeps user-customized vendor names and notes verbatim', () => {
    const custom = {
      id: 'builtin-qwen',
      name: 'My Work Bailian Proxy',
      providerType: 'qwen',
      isBuiltin: true,
      notes: 'Internal team quota only',
    };
    expect(getVendorDisplayName(custom, getProviderDisplayName('qwen', tZh), tZh)).toBe(
      'My Work Bailian Proxy',
    );
    expect(getVendorNotesDisplay(custom, tZh)).toBe('Internal team quota only');
  });

  it('localizes builtin model labels bidirectionally between zh-CN and en-US without leaking CJK in en-US', () => {
    expect(getModelDisplayLabel('Qwen3.7 Max (旗舰/混合思考)', tEn)).toBe('Qwen3.7 Max (Flagship / Hybrid Thinking)');
    expect(getModelDisplayLabel('GLM-5.2 (当前旗舰)', tEn)).toBe('GLM-5.2 (Current Flagship)');
    expect(getModelDisplayLabel('Qwen3.7 Max (Flagship / Hybrid Thinking)', tZh)).toBe('Qwen3.7 Max (旗舰/混合思考)');
    expect(getModelDisplayLabel('Custom Internal Model (Team)', tEn)).toBe('Custom Internal Model (Team)');
  });
});
