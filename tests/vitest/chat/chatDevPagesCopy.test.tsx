/**
 * The dev-only Chat V2 integration test page and its test controls read the chatV2:dev.* keys that already existed:
 * zh-CN renders the Chinese the components hard-coded before, en-US renders English.
 */
import path from 'node:path';
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createStore } from 'zustand/vanilla';
import zhChat from '@/locales/zh-CN/chatV2.json';
import enChat from '@/locales/en-US/chatV2.json';
import type { ChatStore } from '@/features/chat/core/types';

const { language } = await vi.hoisted(async () => ({ language: (await import('i18next')).createInstance() }));
// The suite's default alias only serves Chinese and would hide a missing English key.
vi.mock('react-i18next', () => vi.importActual<typeof import('react-i18next')>(
  path.resolve(process.cwd(), 'node_modules/react-i18next/dist/es/index.js'),
));

const { TestControls } = await import('@/features/chat/dev/TestControls');

const ID = 'RF-W09-chat-dev-integration-test-copy-localized';
const CHECKLIST = ['sendMessage', 'streamingRender', 'stopGeneration', 'guardsWork', 'ankiCards', 'sourcePanel', 'ocrAnalysis', 'noTsErrors', 'noLegacyCode', 'darkMode'] as const;

const COPY = {
  'zh-CN': {
    controls: '测试控制',
    count: '2 条消息',
    page: ['运行测试', '测试日志', '验收清单'],
    checklist: ['发送消息流程完整', '流式渲染正常', '停止生成正常', '守卫机制生效', 'Anki 卡片生成和编辑正常', '来源面板显示正常', 'OCR 分析模式正常', '无 TypeScript 错误', '无旧架构代码残留', '暗色模式全部正常'],
  },
  'en-US': {
    controls: 'Test Controls',
    count: '2 messages',
    page: ['Run Tests', 'Test Logs', 'Acceptance Checklist'],
    checklist: ['Send message flow complete', 'Streaming render works', 'Stop generation works', 'Guards mechanism works', 'Anki cards generation and editing works', 'Source panel displays correctly', 'OCR analysis mode works', 'No TypeScript errors', 'No legacy code remaining', 'Dark mode fully works'],
  },
} as const;

describe('chat dev pages copy', () => {
  beforeAll(async () => {
    await language.init({
      lng: 'zh-CN',
      fallbackLng: false,
      defaultNS: 'chatV2',
      ns: ['chatV2'],
      resources: { 'zh-CN': { chatV2: zhChat }, 'en-US': { chatV2: enChat } },
      interpolation: { escapeValue: false },
    });
  });
  afterEach(() => cleanup());

  it.each(['zh-CN', 'en-US'] as const)(`${ID}: %s test controls header, integration test page and acceptance checklist`, async (lng) => {
    const copy = COPY[lng];
    await language.changeLanguage(lng);
    const store = createStore(() => ({
      sessionStatus: 'idle',
      messageOrder: ['m1', 'm2'],
      features: new Map(),
      canSend: () => true,
      canAbort: () => false,
    }) as unknown as ChatStore);
    const { container } = render(
      <I18nextProvider i18n={language}>
        <TestControls store={store} />
      </I18nextProvider>,
    );
    expect(container.textContent).toContain(copy.controls);
    expect(container.textContent).toContain(copy.count);

    const t = language.getFixedT(lng, 'chatV2');
    expect(['runTests', 'testLogs', 'acceptanceChecklist'].map((k) => t(`dev.integrationTest.${k}`))).toEqual(copy.page);
    expect(CHECKLIST.map((k) => t(`dev.integrationTest.checklist.${k}`))).toEqual(copy.checklist);
  });
});
