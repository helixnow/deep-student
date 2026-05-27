import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GeneralTab } from '../GeneralTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: {
      language: 'zh-CN',
      changeLanguage: vi.fn(),
    },
  }),
}));

vi.mock('@/features/chat/queue/useQueueSettings', () => ({
  useQueueSettings: () => ({
    mode: 'queue',
    loading: true,
    queueEnabled: true,
    allowSteer: false,
    setMode: vi.fn(),
  }),
}));

vi.mock('@/features/chat/hooks/useDevShowRawRequest', async () => {
  const actual = await vi.importActual<typeof import('@/features/chat/hooks/useDevShowRawRequest')>('@/features/chat/hooks/useDevShowRawRequest');
  return {
    ...actual,
    getDefaultConfig: () => ({
      preset: 'standard',
      images: 'placeholder',
      tools: 'summary',
      messages: 'full',
      messageTruncateLength: 2000,
      thinking: 'full',
    }),
    configFromPreset: () => ({
      preset: 'full',
      images: 'full',
      tools: 'full',
      messages: 'full',
      messageTruncateLength: 2000,
      thinking: 'full',
    }),
  };
});

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugMasterSwitch: {
    isEnabled: () => false,
    addListener: () => () => undefined,
    enable: vi.fn(),
    disable: vi.fn(),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/utils/pendingSettingsTab', () => ({
  setPendingSettingsTab: vi.fn(),
}));

vi.mock('../VoiceInputSettingsSection', () => ({
  VoiceInputSettingsSection: () => <div>VoiceInputSettingsSection</div>,
}));

vi.mock('../MemorySettingsSection', () => ({
  MemorySettingsSection: () => <div>MemorySettingsSection</div>,
}));

vi.mock('@/components/legal/UserAgreementDialog', () => ({
  UserAgreementDialog: () => null,
}));

describe('GeneralTab loading states', () => {
  it('hides async switches and queue selector until their settings have loaded', () => {
    render(
      <GeneralTab
        voiceInputAssignedModel={null}
        topbarTopMargin=""
        topbarTopMarginLoaded={false}
        setTopbarTopMargin={vi.fn()}
        logTypeForOpen="backend"
        setLogTypeForOpen={vi.fn()}
        showRawRequest={false}
        showRawRequestLoaded={false}
        setShowRawRequest={vi.fn()}
        invoke={null}
      />,
    );

    expect(screen.queryByRole('switch', { name: '显示消息请求体' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: '匿名错误报告' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'queue' })).not.toBeInTheDocument();
  });
});
