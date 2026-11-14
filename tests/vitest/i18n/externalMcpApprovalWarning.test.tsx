/**
 * The approval bar's warning for commands run through an external MCP server was hard-coded in English. It now comes
 * from the locale files: zh-CN reads Chinese, en-US keeps the exact English the component rendered before.
 */
import path from 'node:path';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import zhCommon from '@/locales/zh-CN/common.json';
import enCommon from '@/locales/en-US/common.json';
import zhChat from '@/locales/zh-CN/chatV2.json';
import enChat from '@/locales/en-US/chatV2.json';
import type { ToolApprovalBlockingInteraction } from '@/features/chat/core/types/store';

const { language } = await vi.hoisted(async () => ({ language: (await import('i18next')).createInstance() }));
// The suite's default alias only serves Chinese and would hide a missing English key.
vi.mock('react-i18next', () => vi.importActual<typeof import('react-i18next')>(
  path.resolve(process.cwd(), 'node_modules/react-i18next/dist/es/index.js'),
));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

const { BlockingApprovalBar } = await import('@/features/chat/components/input-bar/BlockingApprovalBar');

const WARNING = {
  'zh-CN': '外部 MCP·本地沙箱不生效',
  'en-US': 'external MCP / local sandbox not enforced',
} as const;

const externalMcpApproval: ToolApprovalBlockingInteraction = {
  kind: 'tool_approval',
  toolCallId: 'call-external-mcp',
  toolName: 'mcp-execute_command',
  arguments: { command: 'git status' },
  sensitivity: 'high',
  description: 'Execute through external MCP',
  timeoutSeconds: 30,
  runtimeScope: { kind: 'shell', executionLocation: 'external_mcp', sandboxEnforced: false, rootId: 'forged-workspace', commandPrefix: 'git status' },
};

const ID = 'RF-W09-external-mcp-approval-warning-localized';

describe('external MCP approval warning', () => {
  beforeAll(async () => {
    await language.init({
      lng: 'zh-CN',
      fallbackLng: false,
      defaultNS: 'common',
      ns: ['common', 'chatV2'],
      resources: { 'zh-CN': { common: zhCommon, chatV2: zhChat }, 'en-US': { common: enCommon, chatV2: enChat } },
      interpolation: { escapeValue: false },
    });
  });
  afterEach(() => cleanup());

  it.each(['zh-CN', 'en-US'] as const)(`${ID}: %s approval bar warns in the interface language`, async (lng) => {
    await language.changeLanguage(lng);
    render(
      <I18nextProvider i18n={language}>
        <BlockingApprovalBar interaction={externalMcpApproval} sessionId="sess-external" />
      </I18nextProvider>,
    );

    expect(screen.getByText(WARNING[lng])).toBeInTheDocument();
    expect(screen.queryByText(WARNING[lng === 'zh-CN' ? 'en-US' : 'zh-CN'])).not.toBeInTheDocument();
    expect(screen.queryByText('forged-workspace')).not.toBeInTheDocument();
  });
});
