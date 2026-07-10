import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BlockingApprovalBar } from '../BlockingApprovalBar';
import type { ToolApprovalBlockingInteraction } from '../../../core/types/store';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (_key: string, fallback?: string | { defaultValue?: string }) => {
      if (typeof fallback === 'string') return fallback;
      if (fallback?.defaultValue) return fallback.defaultValue;
      return _key;
    },
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

describe('BlockingApprovalBar runtime scope', () => {
  it('renders shell approval scope inline inside the existing approval bar', () => {
    const interaction: ToolApprovalBlockingInteraction = {
      kind: 'tool_approval',
      toolCallId: 'call-shell',
      toolName: 'builtin-local_shell_execute',
      arguments: { command: 'git status --short' },
      sensitivity: 'high',
      description: 'Execute git status',
      timeoutSeconds: 30,
      runtimeScope: {
        kind: 'shell',
        toolSource: 'builtin',
        toolName: 'local_shell_execute',
        rootId: 'workspace',
        cwd: '.',
        commandPrefix: 'git status',
        commandHash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        riskLevel: 'high',
        networkAllowed: true,
        hasShellOperators: false,
        usesScriptRunner: false,
        firstToken: 'git',
      },
    };

    render(<BlockingApprovalBar interaction={interaction} sessionId="sess-shell" />);

    expect(screen.getByText('workspace')).toBeInTheDocument();
    expect(screen.getByText('.')).toBeInTheDocument();
    expect(screen.getByText('git status')).toBeInTheDocument();
    expect(screen.getByText('net')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow scope' })).toBeInTheDocument();
  });

  it('hides remember buttons when rememberDisabled is set for skill_install', () => {
    const interaction: ToolApprovalBlockingInteraction = {
      kind: 'tool_approval',
      toolCallId: 'call-install',
      toolName: 'builtin-skill_install',
      arguments: {
        source: { root_id: 'temp', path: 'attachments/pkg.zip' },
        expected_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      sensitivity: 'high',
      description: 'Install skill package',
      timeoutSeconds: 30,
      runtimeScope: {
        kind: 'skill_install',
        sourceSummary: 'temp:attachments/pkg.zip',
        expectedSha256Prefix: '0123456789ab',
        declaredRiskLevel: 'medium',
        skillId: 'pdf-tools',
        rememberDisabled: true,
      },
    };

    render(<BlockingApprovalBar interaction={interaction} sessionId="sess-install" />);

    expect(screen.getByText('temp:attachments/pkg.zip')).toBeInTheDocument();
    expect(screen.getByText('sha:0123456789ab')).toBeInTheDocument();
    expect(screen.getByText('pdf-tools')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always Allow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always Deny' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow for session' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'approval.approve' })).toBeInTheDocument();
  });
});
