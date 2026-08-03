/**
 * 标签编辑器组件单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { NoteTagsEditor } from '../components/NoteTagsEditor';
import { NotesAPI } from '@/utils/notesApi';

// Mock NotesAPI
vi.mock('@/utils/notesApi', () => ({
    NotesAPI: {
        listTags: vi.fn().mockResolvedValue([]),
    },
}));

const renameTagAcrossNotesMock = vi.fn().mockResolvedValue(0);
vi.mock('../NotesContext', () => ({
    useNotes: () => ({
        renameTagAcrossNotes: renameTagAcrossNotesMock,
    }),
}));

const showGlobalNotificationMock = vi.fn();
vi.mock('@/components/UnifiedNotification', () => ({
    showGlobalNotification: (...args: unknown[]) => showGlobalNotificationMock(...args),
}));

// Mock i18next
vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}));

interface MockPopoverProps {
    children?: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

interface MockInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    className?: string;
}

interface MockBadgeProps {
    children?: React.ReactNode;
    className?: string;
    onClick?: () => void;
}

// 供 mock PopoverTrigger 打开受控 Popover（vi.mock 工厂内可访问 mock 前缀变量）
const mockPopoverControl: { onOpenChange?: (open: boolean) => void; open?: boolean } = {};

// Mock UI components
vi.mock('@/components/ui/shad/Popover', () => ({
    Popover: ({ children, open, onOpenChange }: MockPopoverProps) => {
        mockPopoverControl.onOpenChange = onOpenChange;
        mockPopoverControl.open = open;
        return (
            <div data-testid="popover" data-open={open}>
                {children}
            </div>
        );
    },
    PopoverContent: ({ children }: { children?: React.ReactNode }) => <div data-testid="popover-content">{children}</div>,
    PopoverTrigger: ({ children }: { children?: React.ReactNode }) => (
        <div
            data-testid="popover-trigger"
            onClick={() => mockPopoverControl.onOpenChange?.(!mockPopoverControl.open)}
        >
            {children}
        </div>
    ),
}));

vi.mock('@/components/ui/shad/Input', () => ({
    Input: React.forwardRef<HTMLInputElement, MockInputProps>(({ value, onChange, onKeyDown, className }, ref) => (
        <input
            ref={ref}
            data-testid="input"
            value={value}
            onChange={onChange}
            onKeyDown={onKeyDown}
            className={className}
        />
    )),
}));

vi.mock('@/components/ui/shad/Badge', () => ({
    Badge: ({ children, className, onClick }: MockBadgeProps) => (
        <div data-testid="badge" className={className} onClick={onClick}>{children}</div>
    ),
}));

vi.mock('../../../lib/utils', () => ({
    cn: (...classes: (string | undefined | false)[]) => classes.filter(Boolean).join(' '),
}));

describe('NoteTagsEditor', () => {
    const mockOnTagsChange = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
        mockOnTagsChange.mockClear();
        vi.clearAllMocks();
        vi.mocked(NotesAPI.listTags).mockResolvedValue([]);
        mockOnTagsChange.mockResolvedValue(undefined);
        renameTagAcrossNotesMock.mockResolvedValue(0);
    });

    it('应该正确渲染标签编辑器', () => {
        render(
            <NoteTagsEditor
                noteId="note1"
                initialTags={['tag1', 'tag2']}
                onTagsChange={mockOnTagsChange}
            />
        );

        // 验证标签显示
        expect(screen.getAllByText('tag1').length).toBeGreaterThan(0);
        expect(screen.getAllByText('tag2').length).toBeGreaterThan(0);
    });

    it('触发器应该是可键盘聚焦的真实 button', () => {
        render(
            <NoteTagsEditor
                noteId="note1"
                initialTags={['tag1']}
                onTagsChange={mockOnTagsChange}
            />
        );

        const trigger = screen.getByRole('button', { name: 'notes:header.manage_tags' });
        expect(trigger.tagName).toBe('BUTTON');
        expect(trigger).not.toBeDisabled();
    });

    it('应该能添加新标签', async () => {
        render(
            <NoteTagsEditor
                noteId="note1"
                initialTags={['tag1']}
                onTagsChange={mockOnTagsChange}
            />
        );

        // 点击触发器打开弹窗
        fireEvent.click(screen.getByTestId('popover-trigger'));

        // 输入新标签
        const input = screen.getByTestId('input');
        fireEvent.change(input, { target: { value: 'new-tag' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        // 验证回调被调用
        await waitFor(() => {
            expect(mockOnTagsChange).toHaveBeenCalledWith(['tag1', 'new-tag']);
        });
    });

    it('应该支持方向键选择建议标签后 Enter 添加', async () => {
        vi.mocked(NotesAPI.listTags).mockResolvedValue(['alpha', 'beta']);

        render(
            <NoteTagsEditor
                noteId="note1"
                initialTags={[]}
                onTagsChange={mockOnTagsChange}
            />
        );

        // 打开弹窗以触发建议加载
        fireEvent.click(screen.getByTestId('popover-trigger'));

        // 建议列表应以 listbox/option 语义渲染
        await waitFor(() => {
            expect(screen.getByRole('listbox')).toBeInTheDocument();
            expect(screen.getAllByRole('option')).toHaveLength(2);
        });

        const input = screen.getByTestId('input');
        fireEvent.keyDown(input, { key: 'ArrowDown' });

        await waitFor(() => {
            expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
        });

        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(mockOnTagsChange).toHaveBeenCalledWith(['alpha']);
        });
    });

    it('应该能删除标签', async () => {
        render(
            <NoteTagsEditor
                noteId="note1"
                initialTags={['tag1', 'tag2']}
                onTagsChange={mockOnTagsChange}
            />
        );

        // 点击触发器打开弹窗
        fireEvent.click(screen.getByTestId('popover-trigger'));

        // 点击删除按钮
        const badges = screen.getAllByTestId('badge');
        const tag1Badge = badges.find(b => b.textContent?.includes('tag1'));
        if (tag1Badge) {
            const deleteBtn = tag1Badge.querySelectorAll('button')[1];
            if (deleteBtn) {
                fireEvent.click(deleteBtn);
            }
        }

        // 验证回调被调用
        await waitFor(() => {
            expect(mockOnTagsChange).toHaveBeenCalledWith(['tag2']);
        });
    });

    it('应该能重命名标签', async () => {
        render(
            <NoteTagsEditor
                noteId="note1"
                initialTags={['old-name', 'tag2']}
                onTagsChange={mockOnTagsChange}
            />
        );

        // 点击触发器打开弹窗
        fireEvent.click(screen.getByTestId('popover-trigger'));

        // 点击编辑按钮
        const badges = screen.getAllByTestId('badge');
        const tag1Badge = badges.find(b => b.textContent?.includes('old-name'));
        if (tag1Badge) {
            const editBtn = tag1Badge.querySelectorAll('button')[0]; // 第一个按钮是编辑按钮
            if (editBtn) {
                fireEvent.click(editBtn);
            }
        }

        // 输入新名称
        await waitFor(() => {
            expect(
                screen.getAllByTestId('input').some((el) => (el as HTMLInputElement).value === 'old-name')
            ).toBe(true);
        });
        const input = screen.getAllByTestId('input').find((el) => (el as HTMLInputElement).value === 'old-name') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'new-name' } });

        // 点击确认按钮
        const confirmBtn = screen.getByRole('button', { name: 'notes:header.confirm_rename' });
        if (confirmBtn) {
            fireEvent.click(confirmBtn);
        }

        // 验证重命名逻辑
        await waitFor(() => {
            expect(mockOnTagsChange).toHaveBeenCalledWith(['new-name', 'tag2']);
            expect(renameTagAcrossNotesMock).toHaveBeenCalledWith('old-name', 'new-name', 'note1');
        });
    });

    it('应该防止添加重复标签', async () => {
        render(
            <NoteTagsEditor
                noteId="note1"
                initialTags={['existing-tag']}
                onTagsChange={mockOnTagsChange}
            />
        );

        // 点击触发器打开弹窗
        fireEvent.click(screen.getByTestId('popover-trigger'));

        // 输入已存在的标签
        const input = screen.getByTestId('input');
        fireEvent.change(input, { target: { value: 'existing-tag' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        // 验证没有添加重复标签
        await waitFor(() => {
            expect(mockOnTagsChange).not.toHaveBeenCalledWith(
                expect.arrayContaining([expect.stringContaining('existing-tag')])
            );
        });
    });

    it('应该拒绝大小写不敏感的重复标签并提示', async () => {
        render(
            <NoteTagsEditor
                noteId="note1"
                initialTags={['Existing-Tag']}
                onTagsChange={mockOnTagsChange}
            />
        );

        fireEvent.click(screen.getByTestId('popover-trigger'));

        const input = screen.getByTestId('input');
        fireEvent.change(input, { target: { value: 'existing-tag' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(showGlobalNotificationMock).toHaveBeenCalledWith('warning', 'notes:header.tag_exists');
        });
        expect(mockOnTagsChange).not.toHaveBeenCalled();
    });

    it('应该拒绝纯空白输入', async () => {
        render(
            <NoteTagsEditor
                noteId="note1"
                initialTags={['tag1']}
                onTagsChange={mockOnTagsChange}
            />
        );

        fireEvent.click(screen.getByTestId('popover-trigger'));

        const input = screen.getByTestId('input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '   ' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        // 输入被清空且未触发保存
        await waitFor(() => {
            expect(input.value).toBe('');
        });
        expect(mockOnTagsChange).not.toHaveBeenCalled();
    });
});

describe('NoteTagsEditor inline 模式', () => {
    const mockOnTagsChange = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(NotesAPI.listTags).mockResolvedValue([]);
        mockOnTagsChange.mockResolvedValue(undefined);
        renameTagAcrossNotesMock.mockResolvedValue(0);
    });

    const renderInline = (initialTags: string[], props: Partial<React.ComponentProps<typeof NoteTagsEditor>> = {}) =>
        render(
            <NoteTagsEditor
                noteId="note1"
                variant="inline"
                initialTags={initialTags}
                onTagsChange={mockOnTagsChange}
                {...props}
            />
        );

    it('应该渲染 chips 行与行内输入，且不渲染 popover 触发器', () => {
        renderInline(['tag1', 'tag2']);

        expect(screen.queryByTestId('popover')).not.toBeInTheDocument();
        expect(screen.getByText('tag1')).toBeInTheDocument();
        expect(screen.getByText('tag2')).toBeInTheDocument();

        const input = screen.getByRole('combobox');
        expect(input.tagName).toBe('INPUT');
        expect(input).toHaveAttribute('aria-autocomplete', 'list');
    });

    it('readonly 时不渲染输入与删除按钮', () => {
        renderInline(['tag1'], { readonly: true });

        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        expect(
            screen.queryByRole('button', { name: /notes:header\.remove_tag/ })
        ).not.toBeInTheDocument();
        expect(screen.getByText('tag1')).toBeInTheDocument();
    });

    it('Enter 应提交行内输入的新标签', async () => {
        renderInline(['tag1']);

        const input = screen.getByRole('combobox');
        fireEvent.change(input, { target: { value: 'fresh-tag' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(mockOnTagsChange).toHaveBeenCalledWith(['tag1', 'fresh-tag']);
        });
    });

    it('空输入时 Backspace 应删除末尾 chip', async () => {
        renderInline(['alpha', 'beta']);

        const input = screen.getByRole('combobox');
        fireEvent.keyDown(input, { key: 'Backspace' });

        await waitFor(() => {
            expect(mockOnTagsChange).toHaveBeenCalledWith(['alpha']);
        });
    });

    it('输入非空时 Backspace 不应删除 chip', async () => {
        renderInline(['alpha']);

        const input = screen.getByRole('combobox');
        fireEvent.change(input, { target: { value: 'x' } });
        fireEvent.keyDown(input, { key: 'Backspace' });

        await waitFor(() => {
            expect(mockOnTagsChange).not.toHaveBeenCalled();
        });
    });

    it('聚焦时应展示建议浮层，Esc 应收起', async () => {
        vi.mocked(NotesAPI.listTags).mockResolvedValue(['alpha', 'beta']);
        renderInline([]);

        const input = screen.getByRole('combobox');
        fireEvent.focus(input);

        await waitFor(() => {
            expect(screen.getByRole('listbox')).toBeInTheDocument();
            expect(screen.getAllByRole('option')).toHaveLength(2);
        });

        fireEvent.keyDown(input, { key: 'Escape' });

        await waitFor(() => {
            expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
        });
    });

    it('建议收起后再次 Esc 应清空输入', async () => {
        renderInline(['tag1']);

        const input = screen.getByRole('combobox') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'draft' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        fireEvent.keyDown(input, { key: 'Escape' });

        await waitFor(() => {
            expect(input.value).toBe('');
        });
        expect(mockOnTagsChange).not.toHaveBeenCalled();
    });

    it('点击建议项应添加对应标签', async () => {
        vi.mocked(NotesAPI.listTags).mockResolvedValue(['alpha']);
        renderInline([]);

        const input = screen.getByRole('combobox');
        fireEvent.focus(input);

        await waitFor(() => {
            expect(screen.getByRole('option')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByRole('option'));

        await waitFor(() => {
            expect(mockOnTagsChange).toHaveBeenCalledWith(['alpha']);
        });
    });

    it('inline 模式应拒绝大小写不敏感重名并提示', async () => {
        renderInline(['Alpha']);

        const input = screen.getByRole('combobox');
        fireEvent.change(input, { target: { value: 'alpha' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(showGlobalNotificationMock).toHaveBeenCalledWith('warning', 'notes:header.tag_exists');
        });
        expect(mockOnTagsChange).not.toHaveBeenCalled();
    });

    it('inline 模式应拒绝纯空白输入', async () => {
        renderInline(['tag1']);

        const input = screen.getByRole('combobox') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '  \t ' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(input.value).toBe('');
        });
        expect(mockOnTagsChange).not.toHaveBeenCalled();
    });

    it('点击 chip 删除按钮应移除对应标签', async () => {
        renderInline(['alpha', 'beta']);

        const removeBtn = screen.getByRole('button', { name: 'notes:header.remove_tag: alpha' });
        fireEvent.click(removeBtn);

        await waitFor(() => {
            expect(mockOnTagsChange).toHaveBeenCalledWith(['beta']);
        });
    });

    it('应拒绝超过 100 字符的标签并内联提示', async () => {
        renderInline(['tag1']);

        const input = screen.getByRole('combobox');
        fireEvent.change(input, { target: { value: 'x'.repeat(101) } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('notes:editorV2.tag_too_long');
        });
        expect(mockOnTagsChange).not.toHaveBeenCalled();
    });

    it('标签数量达 100 上限时应拒绝添加并内联提示', async () => {
        const fullTags = Array.from({ length: 100 }, (_, index) => `tag-${index}`);
        renderInline(fullTags);

        const input = screen.getByRole('combobox');
        fireEvent.change(input, { target: { value: 'one-more' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('notes:editorV2.tags_limit_reached');
        });
        expect(mockOnTagsChange).not.toHaveBeenCalled();
    });
});
