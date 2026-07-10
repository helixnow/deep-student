import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
