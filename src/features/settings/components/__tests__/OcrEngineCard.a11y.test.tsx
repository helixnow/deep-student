/**
 * OcrEngineCard 可访问性 / i18n 契约测试
 *
 * 背景（两处用户可见/读屏问题）：
 * 1. 上移/下移图标按钮的 title 走 settings:ocr.move_up / move_down，
 *    但 aria-label 曾是硬编码英文 "move up" / "move down"，读屏用户听到的
 *    与界面提示语言不一致。
 * 2. 系统 OCR 引擎缺省描述曾是源码硬编码中文「调用操作系统内置 OCR 引擎」，
 *    英文用户也只能看到中文。现改走 forms:ocr.system_engine_description。
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import zhSettings from '@/locales/zh-CN/settings.json';
import zhForms from '@/locales/zh-CN/forms.json';
import enForms from '@/locales/en-US/forms.json';

function lookup(obj: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as object)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

// settings 用 zh-CN、forms 故意用 en-US：
// 旧实现的硬编码 fallback 恰好等于 zh-CN 的 forms 文案，
// 用 en-US 才能区分「走了 i18n」和「渲染了源码硬编码中文」。
const NS_BUNDLES: Record<string, Record<string, unknown>> = {
  settings: zhSettings as Record<string, unknown>,
  forms: enForms as Record<string, unknown>,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) => {
      const [ns, bare] = key.includes(':') ? key.split(':', 2) : ['settings', key];
      const bundle = NS_BUNDLES[ns];
      const value = bundle ? lookup(bundle, bare) : undefined;
      if (typeof value === 'string') return value;
      if (typeof options === 'string') return options;
      if (typeof options === 'object' && typeof options?.defaultValue === 'string') {
        return options.defaultValue;
      }
      return key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    switch (command) {
      case 'get_available_ocr_models':
        return [
          {
            configId: 'system-ocr',
            model: 'system',
            engineType: 'system_ocr',
            name: 'System OCR',
            isFree: true,
            // 关键：无 description，触发 fallback 文案
            supportsGrounding: false,
            enabled: true,
            priority: 0,
          },
          {
            configId: 'vlm-1',
            model: 'qwen-vl-max',
            engineType: 'generic_vlm',
            name: 'Qwen VL',
            isFree: false,
            supportsGrounding: true,
            enabled: true,
            priority: 1,
          },
        ];
      case 'get_ocr_engines':
        return [];
      case 'get_ocr_thinking_enabled':
        return false;
      default:
        return null;
    }
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('../OcrEngineTestPanel', () => ({
  OcrEngineTestPanel: () => <div data-testid="ocr-test-panel" />,
}));

vi.mock('@/components/shared/UnifiedModelSelector', () => ({
  UnifiedModelSelector: () => <div data-testid="unified-model-selector" />,
}));

vi.mock('@/components/ui/SiliconFlowLogo', () => ({
  SiliconFlowLogo: () => <span data-testid="siliconflow-logo" />,
}));

import { OcrEngineCard } from '../OcrEngineCard';

const zhOcr = (zhSettings as { ocr: Record<string, string> }).ocr;

function renderCard() {
  return render(
    <OcrEngineCard
      apiConfigs={[]}
      toUnifiedModelInfo={() => []}
      getAllEnabledApis={() => []}
    />
  );
}

describe('OcrEngineCard a11y & i18n', () => {
  it('move up/down buttons expose localized aria-labels, not hardcoded English', async () => {
    renderCard();

    await waitFor(() => {
      expect(screen.getByText('Qwen VL')).toBeInTheDocument();
    });

    // aria-label 与 title 使用同一份 i18n 文案（每个引擎行各一对按钮）
    expect(screen.getAllByRole('button', { name: zhOcr.move_up })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: zhOcr.move_down })).toHaveLength(2);

    // 不再暴露硬编码英文可访问名
    expect(screen.queryByRole('button', { name: 'move up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'move down' })).toBeNull();
  });

  it('system OCR engine without description falls back to the forms i18n text', async () => {
    renderCard();

    await waitFor(() => {
      expect(screen.getByText('System OCR')).toBeInTheDocument();
    });

    // forms 命名空间挂的是 en-US，因此渲染英文文案即证明走了 i18n
    expect(
      screen.getByText((enForms as typeof enForms).ocr.system_engine_description)
    ).toBeInTheDocument();
    // 源码硬编码中文不得再出现
    expect(screen.queryByText('调用操作系统内置 OCR 引擎')).toBeNull();
  });

  it('both locales define forms:ocr.system_engine_description', () => {
    expect(zhForms.ocr.system_engine_description).toBe('调用操作系统内置 OCR 引擎');
    expect(enForms.ocr.system_engine_description).toBe(
      'Uses the operating system built-in OCR engine'
    );
  });

  it('source contract: no hardcoded a11y strings remain in OcrEngineCard.tsx', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/OcrEngineCard.tsx'),
      'utf-8'
    );

    expect(source).not.toContain('"move up"');
    expect(source).not.toContain('"move down"');
    expect(source).not.toContain('调用操作系统内置 OCR 引擎');

    expect(source).toContain("aria-label={t('settings:ocr.move_up')}");
    expect(source).toContain("aria-label={t('settings:ocr.move_down')}");
    expect(source).toContain("t('forms:ocr.system_engine_description')");
  });
});
