/**
 * 「保存为笔记」目录选择流程的行为契约。
 *
 * 锁住四件事：
 * 1. start() 只是打开目录选择器，用户没确认前不写盘
 * 2. 确认后才带着 folderId 落库，取消则整单丢弃
 * 3. 窄屏走 inline 全屏子屏，不用桌面 Dialog
 * 4. inline 分支对统一顶栏通道隔离（Provider value={null}）：即使外层存在
 *    宿主（learning-hub 移动分支），FolderPickerDialog 也视为无宿主，
 *    保持自绘返回行、不向宿主 setSubviewChrome（Wave2-C R6 08-chrome §A）；
 *    桌面 Dialog 分支不隔离
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

// mock 与真组件同构地消费统一顶栏通道（真实 useMobileSubviewChrome + screen:'center'），
// 用于断言 inline 分支的 Provider value={null} 隔离确实让它看不到外层宿主
vi.mock('@/features/learning-hub/components/finder/FolderPickerDialog', async () => {
  const { useMobileSubviewChrome } = await import('@/components/layout');
  const FolderPickerDialog: React.FC<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (folderId: string | null) => void;
    title: string;
    inline?: boolean;
  }> = ({ open, onOpenChange, onConfirm, title, inline }) => {
    const hosted = useMobileSubviewChrome(
      { title, onBack: () => onOpenChange(false), screen: 'center' },
      [title, onOpenChange],
      Boolean(inline && open),
    );
    if (!open) return null;
    return (
      <div
        data-testid="folder-picker"
        data-inline={inline ? 'true' : 'false'}
        data-hosted={hosted ? 'true' : 'false'}
      >
        <span>{title}</span>
        <button onClick={() => onConfirm('folder-7')}>confirm</button>
        <button onClick={() => onOpenChange(false)}>cancel</button>
      </div>
    );
  };
  return { FolderPickerDialog };
});

import { MobileSubviewChromeProvider } from '@/components/layout';
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

  it('isolates the inline picker from an outer subview-chrome host: self-drawn header, no setSubviewChrome', () => {
    // 复现 R6 §A：小屏 learning-hub 内 PDF 划词「保存为笔记」，picker 树上
    // 存在 LearningHubPage 的 chrome 宿主。隔离层必须让 FolderPickerDialog
    // 视为无宿主（hosted=false → 自绘返回行），且完全不向宿主推 chrome。
    isSmallScreen = true;
    const setSubviewChrome = vi.fn();
    render(
      <MobileSubviewChromeProvider value={{ setSubviewChrome }}>
        <Host />
      </MobileSubviewChromeProvider>,
    );
    act(() => start({ content: '划选的正文' }));

    const picker = screen.getByTestId('folder-picker');
    expect(picker.getAttribute('data-inline')).toBe('true');
    expect(picker.getAttribute('data-hosted')).toBe('false');
    expect(setSubviewChrome).not.toHaveBeenCalled();
  });

  it('does not isolate the desktop dialog branch from a subview-chrome host', () => {
    // 锁「桌面 Dialog 分支不要包」：非 inline 时 FolderPickerDialog 仍能
    // 看到外层宿主（中屏「移动到…」真接管场景依赖 hosted=true 语义）。
    isSmallScreen = false;
    const setSubviewChrome = vi.fn();
    render(
      <MobileSubviewChromeProvider value={{ setSubviewChrome }}>
        <Host />
      </MobileSubviewChromeProvider>,
    );
    act(() => start({ content: '划选的正文' }));

    const picker = screen.getByTestId('folder-picker');
    expect(picker.getAttribute('data-inline')).toBe('false');
    expect(picker.getAttribute('data-hosted')).toBe('true');
  });
});
