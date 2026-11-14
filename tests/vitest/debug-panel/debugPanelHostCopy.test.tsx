/**
 * The Analysis Panel header and resize handle read their copy from `common:debug_panel.*`. zh-CN keeps the strings the
 * host hard-coded before (the debug panel goldens under src/debug-panel/__tests__/__golden__ are captured in zh-CN);
 * en-US shows English instead of the Chinese tooltips and toggle labels.
 */
import path from 'node:path';
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import zhCommon from '@/locales/zh-CN/common.json';
import enCommon from '@/locales/en-US/common.json';
import { setUILabEnabled } from '@/utils/uiLabToggle';

const { language } = await vi.hoisted(async () => ({ language: (await import('i18next')).createInstance() }));
// The suite's default alias only serves Chinese and would hide a missing English key.
vi.mock('react-i18next', () => vi.importActual<typeof import('react-i18next')>(
  path.resolve(process.cwd(), 'node_modules/react-i18next/dist/es/index.js'),
));
vi.mock('@/debug-panel/panels', () => ({}));

const { default: DebugPanelHost } = await import('@/debug-panel/DebugPanelHost');

interface HeaderCopy {
  title: string;
  playground: string;
  playgroundHint: string;
  devtoolsHint: string;
  uiLabOff: string;
  uiLabOffHint: string;
  uiLabOn: string;
  uiLabOnHint: string;
  resizeHint: string;
}

const ZH_CN: HeaderCopy = {
  title: 'Analysis Panel',
  playground: 'LLM Playground',
  playgroundHint: 'LLM 输出模拟游乐场',
  devtoolsHint: '打开/关闭 WebView DevTools (F12)',
  uiLabOff: 'UI Lab 关',
  uiLabOffHint: '样式调试已关闭，点击开启',
  uiLabOn: 'UI Lab 开',
  uiLabOnHint: '样式调试已开启，点击关闭',
  resizeHint: '拖动以调整大小',
};

const EN_US: HeaderCopy = {
  title: 'Analysis Panel',
  playground: 'LLM Playground',
  playgroundHint: 'LLM output simulation playground',
  devtoolsHint: 'Open/close WebView DevTools (F12)',
  uiLabOff: 'UI Lab Off',
  uiLabOffHint: 'Style debugging disabled, click to enable',
  uiLabOn: 'UI Lab On',
  uiLabOnHint: 'Style debugging enabled, click to disable',
  resizeHint: 'Drag to resize',
};

const header = () => document.querySelector('.dbg-header') as HTMLElement;
const buttonByText = (text: string) =>
  Array.from(header().querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ?? null;

describe('DebugPanelHost header copy', () => {
  beforeAll(async () => {
    await language.init({
      lng: 'zh-CN',
      fallbackLng: false,
      defaultNS: 'common',
      ns: ['common'],
      resources: { 'zh-CN': { common: zhCommon }, 'en-US': { common: enCommon } },
      interpolation: { escapeValue: false },
    });
  });
  beforeEach(() => setUILabEnabled(false));
  afterEach(() => {
    cleanup();
    setUILabEnabled(false);
  });

  it.each([
    ['zh-CN', ZH_CN],
    ['en-US', EN_US],
  ] as const)('RF-W09-debug-panel-host-copy-localized: %s header, UI Lab toggle and resize handle', async (lng, copy) => {
    await language.changeLanguage(lng);
    render(
      <I18nextProvider i18n={language}>
        <DebugPanelHost visible onClose={() => {}} />
      </I18nextProvider>,
    );

    expect(header().textContent).toContain(copy.title);
    expect(buttonByText(copy.playground)?.getAttribute('title')).toBe(copy.playgroundHint);
    expect(buttonByText('DevTools')?.getAttribute('title')).toBe(copy.devtoolsHint);
    expect(buttonByText(copy.uiLabOff)?.getAttribute('title')).toBe(copy.uiLabOffHint);
    expect(document.querySelector('.dbg-resize')?.getAttribute('title')).toBe(copy.resizeHint);

    await act(async () => { setUILabEnabled(true); });
    expect(buttonByText(copy.uiLabOn)?.getAttribute('title')).toBe(copy.uiLabOnHint);
    expect(buttonByText(copy.uiLabOff)).toBeNull();
  });
});
