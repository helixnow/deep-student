/**
 * 「保存为笔记」目录选择流程的行为契约。
 *
 * 锁住三件事：
 * 1. start() 只是打开目录选择器，用户没确认前不写盘
 * 2. 确认后才带着 folderId 落库，取消则整单丢弃
 * 3. 窄屏走 inline 全屏子屏，不用桌面 Dialog
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

const saveTextAsNoteAndNotify = vi.fn();
let isSmallScreen = false;

vi.mock('../saveTextAsNote', () => ({
  saveTextAsNoteAndNotify: (...args: unknown[]) => saveTextAsNoteAndNotify(...args),
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen }),
}));

vi.mock('@/features/learning-hub/components/finder/FolderPickerDialog', () => ({
  FolderPickerDialog: ({
    open,
    onOpenChange,
    onConfirm,
    title,
    inline,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (folderId: string | null) => void;
    title: string;
    inline?: boolean;
  }) =>
    open ? (
      <div data-testid="folder-picker" data-inline={inline ? 'true' : 'false'}>
        <span>{title}</span>
        <button onClick={() => onConfirm('folder-7')}>confirm</button>
        <button onClick={() => onOpenChange(false)}>cancel</button>
      </div>
    ) : null,
}));

import { useSaveAsNoteFlow, SaveAsNoteFolderPicker, type SaveAsNoteRequest } from '../useSaveAsNoteFlow';

let start: (request: SaveAsNoteRequest) => void;

const Host: React.FC = () => {
  const flow = useSaveAsNoteFlow({ openSource: 'pdf-selection' });
  start = flow.start;
  return (
    <>
      <span data-testid="saving">{String(flow.isSaving)}</span>
      <SaveAsNoteFolderPicker {...flow.pickerProps} />
    </>
  );
};

beforeEach(() => {
  cleanup();
  isSmallScreen = false;
  saveTextAsNoteAndNotify.mockReset();
  saveTextAsNoteAndNotify.mockResolvedValue({ ok: true, noteId: 'note-1', title: '标题' });
});

describe('useSaveAsNoteFlow', () => {
  it('keeps the picker closed until a save starts', () => {
    render(<Host />);
    expect(screen.queryByTestId('folder-picker')).toBeNull();
  });

  it('ignores blank content instead of opening an empty picker', () => {
    render(<Host />);
    act(() => start({ content: '   \n' }));
    expect(screen.queryByTestId('folder-picker')).toBeNull();
  });

  it('opens the picker without writing anything yet', () => {
    render(<Host />);
    act(() => start({ content: '划选的正文' }));
    expect(screen.getByTestId('folder-picker')).toBeTruthy();
    expect(saveTextAsNoteAndNotify).not.toHaveBeenCalled();
  });

  it('saves into the confirmed folder and closes the picker', async () => {
    render(<Host />);
    act(() => start({ content: '划选的正文', title: '标题', tags: ['tag'] }));
    await act(async () => {
      screen.getByText('confirm').click();
    });

    expect(saveTextAsNoteAndNotify).toHaveBeenCalledWith(
      { content: '划选的正文', title: '标题', tags: ['tag'], folderId: 'folder-7' },
      { openSource: 'pdf-selection' },
    );
    expect(screen.queryByTestId('folder-picker')).toBeNull();
  });

  it('drops the request when the picker is dismissed', () => {
    render(<Host />);
    act(() => start({ content: '划选的正文' }));
    act(() => {
      screen.getByText('cancel').click();
    });
    expect(screen.queryByTestId('folder-picker')).toBeNull();
    expect(saveTextAsNoteAndNotify).not.toHaveBeenCalled();
  });

  it('uses the inline full-screen picker on small screens', () => {
    isSmallScreen = true;
    render(<Host />);
    act(() => start({ content: '划选的正文' }));
    expect(screen.getByTestId('folder-picker').getAttribute('data-inline')).toBe('true');
  });
});
