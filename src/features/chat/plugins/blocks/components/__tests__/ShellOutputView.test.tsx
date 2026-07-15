import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { extractShellExecuteOutput, ShellOutputView } from '../ShellOutputView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; code?: number | string }) => {
      if (key === 'shellOutput.exitCode' && opts?.code !== undefined) {
        return `退出码 ${opts.code}`;
      }
      return opts?.defaultValue ?? key;
    },
  }),
}));

describe('ShellOutputView', () => {
  it('extractShellExecuteOutput unwraps nested result', () => {
    const data = extractShellExecuteOutput({
      result: {
        command: 'git status',
        exit_code: 0,
        success: true,
        stdout: 'clean',
        stderr: '',
      },
    });
    expect(data?.command).toBe('git status');
    expect(data?.exit_code).toBe(0);
  });

  it('renders stdout/stderr panes and exit code', () => {
    render(
      <ShellOutputView
        output={{
          command: 'echo hello',
          exit_code: 0,
          success: true,
          stdout: 'hello\n',
          stderr: '',
          duration_ms: 42,
          root_id: 'workspace',
          cwd: '.',
        }}
      />,
    );
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText('退出码 0')).toBeInTheDocument();
  });

  it('renders root and Windows PowerShell UTF-8 sandbox metadata', () => {
    render(
      <ShellOutputView
        output={{
          command: 'Write-Output "中文输出"',
          exit_code: 0,
          success: true,
          stdout: '中文输出\n',
          stderr: '',
          root_id: 'workspace',
          root: {
            path: 'C:\\Users\\student\\project',
            access: 'read_only',
          },
          sandbox: {
            backend: 'windows_appcontainer_job',
            shell_kind: 'windows_powershell',
            output_encoding: 'utf-8',
            enforced: true,
            readable_roots: 3,
          },
          env_policy: {
            inherit_parent_env: true,
            allowlist_mode: true,
            inherited_keys: ['PATH', 'LANG'],
            explicit_keys: [],
          },
        }}
      />,
    );

    expect(screen.getByText('中文输出')).toBeInTheDocument();
    expect(screen.getByText('C:\\Users\\student\\project')).toBeInTheDocument();
    expect(screen.getByText('read_only')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '执行策略' }));
    expect(screen.getByText('sandbox:windows_appcontainer_job')).toBeInTheDocument();
    expect(screen.getByText('shell:windows_powershell')).toBeInTheDocument();
    expect(screen.getByText('encoding:utf-8')).toBeInTheDocument();
    expect(screen.getByText('readable-roots:3')).toBeInTheDocument();
    expect(screen.getByText('parent-env')).toBeInTheDocument();
    expect(screen.getByText('inherited:2 [PATH, LANG]')).toHaveAttribute('title', 'PATH, LANG');
  });

  it('renders only the redacted command and its audit hash', () => {
    render(
      <ShellOutputView
        output={{
          command: 'curl --token [REDACTED] https://example.test',
          command_hash: 'abcdef1234567890abcdef1234567890',
          command_redacted: true,
          raw_command: 'curl --token raw-secret-value https://example.test',
          exit_code: 0,
          success: true,
          stdout: 'ok',
          stderr: '',
        }}
      />,
    );

    expect(screen.getByText('curl --token [REDACTED] https://example.test')).toBeInTheDocument();
    expect(screen.queryByText(/raw-secret-value/)).not.toBeInTheDocument();
    expect(screen.getByText('command:redacted')).toBeInTheDocument();
    expect(screen.getByText('hash:abcdef12')).toHaveAttribute(
      'title',
      'abcdef1234567890abcdef1234567890',
    );
  });
});
