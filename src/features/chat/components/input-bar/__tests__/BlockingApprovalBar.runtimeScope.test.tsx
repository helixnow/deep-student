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
  it('offers only one-shot actions when a stale relaxed Medium approval is rendered', () => {
    const interaction: ToolApprovalBlockingInteraction = {
      kind: 'tool_approval',
      toolCallId: 'call-relaxed-medium',
      toolName: 'builtin-test',
      arguments: {},
      sensitivity: 'medium',
      permissionPreset: 'relaxed',
      description: 'stale approval',
      timeoutSeconds: 30,
    };

    render(<BlockingApprovalBar interaction={interaction} sessionId="sess-relaxed" />);

    expect(screen.getByRole('button', { name: 'approval.approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'approval.reject' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'approval.allowSession' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'approval.alwaysAllow' })).not.toBeInTheDocument();
  });

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
    expect(screen.queryByRole('button', { name: 'approval.allowScope' })).not.toBeInTheDocument();
  });

  it('shows the bound root authority and effective sandbox-readable roots', () => {
    const interaction: ToolApprovalBlockingInteraction = {
      kind: 'tool_approval',
      toolCallId: 'call-shell-authority',
      toolName: 'builtin-local_shell_execute',
      arguments: { command: 'git status --short' },
      sensitivity: 'high',
      description: 'Execute git status',
      timeoutSeconds: 30,
      runtimeScope: {
        kind: 'shell',
        rootId: 'workspace',
        rootPath: '/Users/student/project',
        rootAccess: 'read_only',
        rootSessionScoped: false,
        rootBinding: 'abcdef1234567890abcdef1234567890',
        readableRoots: ['/Users/student/project', '/tmp/deep-student/session'],
        sandboxBackend: 'macos_seatbelt',
        shellKind: 'posix_sh',
        outputEncoding: 'utf-8',
        executionLocation: 'local_device',
        sandboxEnforced: true,
        inheritEnv: true,
        inheritedEnvKeys: ['PATH', 'LANG'],
        explicitEnvKeys: ['CI'],
        containsPotentialSecret: true,
        cwd: '.',
        commandPrefix: 'git status',
        commandHash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      },
    };

    render(<BlockingApprovalBar interaction={interaction} sessionId="sess-shell" />);

    expect(screen.getByText('/Users/student/project')).toBeInTheDocument();
    expect(screen.getByText('read_only')).toBeInTheDocument();
    expect(screen.getByText('persistent-root')).toBeInTheDocument();
    expect(screen.getByText('sandbox:macos_seatbelt')).toBeInTheDocument();
    expect(screen.getByText('local_device')).toBeInTheDocument();
    expect(screen.getByText('sandbox:enforced')).toBeInTheDocument();
    expect(screen.getByText('shell:posix_sh')).toBeInTheDocument();
    expect(screen.getByText('encoding:utf-8')).toBeInTheDocument();
    expect(screen.getByText('command:redacted')).toBeInTheDocument();
    expect(screen.getByText('parent-env')).toBeInTheDocument();
    expect(screen.getByText('inherited:2 [PATH, LANG]')).toHaveAttribute('title', 'PATH, LANG');
    expect(screen.getByText('explicit-env:1 [CI]')).toHaveAttribute('title', 'CI');
    expect(screen.getByText('bind:abcdef12')).toHaveAttribute(
      'title',
      'abcdef1234567890abcdef1234567890',
    );
    expect(screen.getByText('read:/tmp/deep-student/session')).toBeInTheDocument();
  });

  it('does not invent parent environment authority for an older payload', () => {
    const interaction: ToolApprovalBlockingInteraction = {
      kind: 'tool_approval',
      toolCallId: 'call-shell-legacy',
      toolName: 'builtin-local_shell_execute',
      arguments: { command: 'pwd' },
      sensitivity: 'high',
      description: 'Print working directory',
      timeoutSeconds: 30,
      runtimeScope: {
        kind: 'shell',
        rootId: 'workspace',
        cwd: '.',
        commandPrefix: 'pwd',
        commandHash: '1234567890abcdef',
      },
    };

    render(<BlockingApprovalBar interaction={interaction} sessionId="sess-shell" />);

    expect(screen.queryByText('parent-env')).not.toBeInTheDocument();
    expect(screen.queryByText(/^inherited:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^explicit-env:/)).not.toBeInTheDocument();
  });

  it('warns for external MCP execution and suppresses forged local sandbox metadata', () => {
    const interaction: ToolApprovalBlockingInteraction = {
      kind: 'tool_approval',
      toolCallId: 'call-external-mcp',
      toolName: 'mcp-execute_command',
      arguments: { command: 'git status' },
      sensitivity: 'high',
      description: 'Execute through external MCP',
      timeoutSeconds: 30,
      runtimeScope: {
        kind: 'shell',
        executionLocation: 'external_mcp',
        sandboxEnforced: false,
        rootId: 'forged-workspace',
        rootPath: '/forged/local/root',
        rootAccess: 'read_write',
        cwd: '/forged/local/root',
        commandPrefix: 'git status',
        commandHash: '1234567890abcdef',
        sandboxBackend: 'forged_local_sandbox',
        shellKind: 'posix_sh',
        outputEncoding: 'utf-8',
        readableRoots: ['/forged/readable/root'],
      },
    };

    render(<BlockingApprovalBar interaction={interaction} sessionId="sess-shell" />);

    expect(screen.getByText('external MCP / local sandbox not enforced')).toBeInTheDocument();
    expect(screen.queryByText('forged-workspace')).not.toBeInTheDocument();
    expect(screen.queryByText('/forged/local/root')).not.toBeInTheDocument();
    expect(screen.queryByText('sandbox:forged_local_sandbox')).not.toBeInTheDocument();
    expect(screen.queryByText('read:/forged/readable/root')).not.toBeInTheDocument();
  });

  it('hides remember buttons when rememberDisabled is set for skill_install', () => {
    const interaction: ToolApprovalBlockingInteraction = {
      kind: 'tool_approval',
      toolCallId: 'call-install',
      toolName: 'builtin-skill_install',
      arguments: {
        source: { root_id: 'temp', path: 'attachments/pkg.zip' },
        expected_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        skill_id: 'pdf-tools',
        overwrite: true,
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
        overwriteExisting: true,
        rememberDisabled: true,
      },
    };

    render(<BlockingApprovalBar interaction={interaction} sessionId="sess-install" />);

    expect(screen.getByText('temp:attachments/pkg.zip')).toBeInTheDocument();
    expect(screen.getByText('sha:0123456789ab')).toBeInTheDocument();
    expect(screen.getByText('pdf-tools')).toBeInTheDocument();
    expect(screen.getByText('overwrite')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always Allow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always Deny' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow for session' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'approval.approve' })).toBeInTheDocument();
  });

  it('shows the content hash bound to a skill workshop approval', () => {
    const interaction: ToolApprovalBlockingInteraction = {
      kind: 'tool_approval',
      toolCallId: 'call-workshop',
      toolName: 'builtin-skill_workshop_apply',
      arguments: {
        proposal_id: 'wp_1234567890_abcd',
        skill_id: 'reviewed-skill',
        expected_content_sha256:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        expected_proposal_revision:
          'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        overwrite: true,
      },
      sensitivity: 'high',
      description: 'Apply reviewed skill proposal',
      timeoutSeconds: 30,
      runtimeScope: {
        kind: 'skill_workshop',
        sourceSummary: 'wp_1234567890_abcd',
        expectedSha256Prefix: '0123456789ab',
        skillId: 'reviewed-skill',
        overwriteExisting: true,
        riskLevel: 'high',
        rememberDisabled: true,
      },
    };

    render(<BlockingApprovalBar interaction={interaction} sessionId="sess-workshop" />);

    expect(screen.getByText('wp_1234567890_abcd')).toBeInTheDocument();
    expect(screen.getByText('sha:0123456789ab')).toBeInTheDocument();
    expect(screen.getByText('reviewed-skill')).toBeInTheDocument();
    expect(screen.getByText('overwrite')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always Allow' })).not.toBeInTheDocument();
  });
});
