/**
 * 标签编辑器组件单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { NoteTagsEditor } from '../components/NoteTagsEditor';

// Mock NotesAPI
vi.mock('../../../utils/notesApi', () => ({
    NotesAPI: {
        listTags: vi.fn(),
    },
}));

const renameTagAcrossNotesMock = vi.fn().mockResolvedValue(0);
vi.mock('../NotesContext', () => ({
    useNotes: () => ({
        renameTagAcrossNotes: renameTagAcrossNotesMock,
    }),
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

interface MockInputProps {
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    className?: string;
}

interface MockBadgeProps {
    children?: React.ReactNode;
    className?: string;
}

// Mock UI components
vi.mock('../../ui/shad/Popover', () => ({
    Popover: ({ children, open, onOpenChange }: MockPopoverProps) => (
        <div data-testid="popover" data-open={open} onClick={() => onOpenChange?.(!open)}>
            {children}
        </div>
    ),
    PopoverContent: ({ children }: { children?: React.ReactNode }) => <div data-testid="popover-content">{children}</div>,
    PopoverTrigger: ({ children }: { children?: React.ReactNode }) => <div data-testid="popover-trigger">{children}</div>,
}));

vi.mock('../../ui/shad/Input', () => ({
    Input: ({ value, onChange, onKeyDown, className }: MockInputProps) => (
        <input
            data-testid="input"
            value={value}
            onChange={onChange}
            onKeyDown={onKeyDown}
            className={className}
        />
    ),
}));

vi.mock('../../ui/shad/Badge', () => ({
    Badge: ({ children, className }: MockBadgeProps) => (
        <div data-testid="badge" className={className}>{children}</div>
    ),
}));

vi.mock('../../../lib/utils', () => ({
    cn: (...classes: (string | undefined | false)[]) => classes.filter(Boolean).join(' '),
}));

describe('NoteTagsEditor', () => {
    const mockOnTagsChange = vi.fn();

    beforeEach(() => {
        mockOnTagsChange.mockClear();
        vi.clearAllMocks();
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
        expect(screen.getByText('tag1')).toBeInTheDocument();
        expect(screen.getByText('tag2')).toBeInTheDocument();
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
            const deleteBtn = tag1Badge.querySelector('button');
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
            expect(screen.getByTestId('input')).toBeInTheDocument();
        });
        const input = screen.getByTestId('input');
        fireEvent.change(input, { target: { value: 'new-name' } });

        // 点击确认按钮
        const confirmBtn = screen.getByTestId('popover-content').querySelectorAll('button')[0];
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
});
