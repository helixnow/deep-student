import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DesktopShellTitleEditor } from '../DesktopShellTitleEditor';

const defaultProps = {
  sessionId: 'sess-1',
  title: '原会话标题',
  renameLabel: '重命名会话',
  emptyTitleError: '请输入会话名称',
  saveError: '重命名失败，请稍后重试',
};

describe('DesktopShellTitleEditor', () => {
  it('opens from the title and saves the edited draft on Enter', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(<DesktopShellTitleEditor {...defaultProps} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: defaultProps.renameLabel }));
    const input = screen.getByRole('textbox', { name: defaultProps.renameLabel });
    await user.clear(input);
    await user.type(input, ' 新标题 ');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('sess-1', '新标题');
    });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('saves on blur', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(<DesktopShellTitleEditor {...defaultProps} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: defaultProps.renameLabel }));
    const input = screen.getByRole('textbox', { name: defaultProps.renameLabel });
    await user.clear(input);
    await user.type(input, '失焦标题');
    await user.click(document.body);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('sess-1', '失焦标题');
    });
  });

  it('cancels on Escape and rejects empty titles', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(<DesktopShellTitleEditor {...defaultProps} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: defaultProps.renameLabel }));
    const input = screen.getByRole('textbox', { name: defaultProps.renameLabel });
    await user.clear(input);
    await user.keyboard('{Enter}');

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(defaultProps.emptyTitleError);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText(defaultProps.title)).toBeInTheDocument();
  });

  it('keeps editing and shows an error when saving fails', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new Error('backend failure');
    });
    render(<DesktopShellTitleEditor {...defaultProps} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: defaultProps.renameLabel }));
    const input = screen.getByRole('textbox', { name: defaultProps.renameLabel });
    await user.clear(input);
    await user.type(input, '新标题');
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(defaultProps.saveError);
    expect(screen.getByRole('textbox')).toHaveValue('新标题');
  });
});
