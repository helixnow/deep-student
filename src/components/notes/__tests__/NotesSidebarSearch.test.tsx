/**
 * 搜索栏组件单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { NotesSidebarSearch } from '../components/NotesSidebarSearch';
import * as NotesContextModule from '../NotesContext';
import * as NotesAPIModule from '../../../utils/notesApi';

// Mock useNotes
vi.mock('../NotesContext', () => ({
    useNotes: vi.fn(() => ({
        performSearch: vi.fn(),
        setSearchQuery: vi.fn(),
        searchQuery: '',
    })),
}));

// Mock NotesAPI
vi.mock('../../../utils/notesApi', () => ({
    NotesAPI: {
        listTags: vi.fn(),
    },
}));

// Mock useDebounce
vi.mock('../../../hooks/useDebounce', () => ({
    useDebounce: (value: string) => value,
}));

// Mock i18next
vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}));

interface MockInputProps {
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
}

interface MockButtonProps {
    children?: React.ReactNode;
    onClick?: () => void;
    className?: string;
}

interface MockPopoverProps {
    children?: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}

interface MockBadgeProps {
    children?: React.ReactNode;
    className?: string;
}

// Mock UI components
vi.mock('../../ui/shad/Input', () => ({
    Input: ({ value, onChange, placeholder }: MockInputProps) => (
        <input data-testid="search-input" value={value} onChange={onChange} placeholder={placeholder} />
    ),
}));

vi.mock('@/components/ui/NotionButton', () => ({
    NotionButton: ({ children, onClick, className, ...props }: MockButtonProps & { [key: string]: unknown }) => (
        <button data-testid="notion-button" onClick={onClick} className={className} {...props}>
            {children}
        </button>
    ),
}));

vi.mock('../../ui/shad/Popover', () => ({
    Popover: ({ children, open, onOpenChange }: MockPopoverProps) => (
        <div data-testid="popover" data-open={open} onClick={() => onOpenChange?.(!open)}>
            {children}
        </div>
    ),
    PopoverContent: ({ children }: { children?: React.ReactNode }) => <div data-testid="popover-content">{children}</div>,
    PopoverTrigger: ({ children }: { children?: React.ReactNode }) => <div data-testid="popover-trigger">{children}</div>,
}));

vi.mock('../../ui/shad/Badge', () => ({
    Badge: ({ children, className }: MockBadgeProps) => (
        <div data-testid="badge" className={className}>{children}</div>
    ),
}));

vi.mock('../../../lib/utils', () => ({
    cn: (...classes: (string | undefined | false)[]) => classes.filter(Boolean).join(' '),
}));

describe('NotesSidebarSearch', () => {
    let mockPerformSearch: ReturnType<typeof vi.fn>;
    let mockSetSearchQuery: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockPerformSearch = vi.fn();
        mockSetSearchQuery = vi.fn();

        vi.mocked(NotesContextModule.useNotes).mockReturnValue({
            performSearch: mockPerformSearch,
            setSearchQuery: mockSetSearchQuery,
            searchQuery: '',
        } as ReturnType<typeof NotesContextModule.useNotes>);
    });

    it('应该正确渲染搜索输入框', () => {
        render(<NotesSidebarSearch />);

        expect(screen.getByTestId('search-input')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('notes:sidebar.search.search_placeholder')).toBeInTheDocument();
    });

    it('应该能输入搜索词', async () => {
        render(<NotesSidebarSearch />);

        const input = screen.getByTestId('search-input');
        fireEvent.change(input, { target: { value: 'test query' } });

        await waitFor(() => {
            expect(mockPerformSearch).toHaveBeenCalledWith('test query', []);
        });
    });

    it('应该能清除搜索词', async () => {
        render(<NotesSidebarSearch />);

        const input = screen.getByTestId('search-input');
        fireEvent.change(input, { target: { value: 'test query' } });

        await waitFor(() => {
            expect(mockPerformSearch).toHaveBeenCalledWith('test query', []);
        });

        const clearButton = screen.getAllByTestId('notion-button').at(-1);
        if (!clearButton) {
            throw new Error('Clear button not found');
        }
        fireEvent.click(clearButton);

        await waitFor(() => {
            expect(input).toHaveValue('');
            expect(mockPerformSearch).toHaveBeenCalledWith('', []);
        });
    });

    it('应该能加载并显示标签', async () => {
        vi.mocked(NotesAPIModule.NotesAPI.listTags).mockResolvedValue(['tag1', 'tag2', 'tag3']);

        render(<NotesSidebarSearch />);

        // 点击过滤器按钮
        const filterButtons = screen.getAllByTestId('button');
        const filterButton = filterButtons.find(btn => btn.querySelector('svg'));
        if (filterButton) {
            fireEvent.click(filterButton);
        }

        // 等待标签加载
        await waitFor(() => {
            expect(NotesAPIModule.NotesAPI.listTags).toHaveBeenCalled();
        });
    });

    it('应该能按标签过滤', async () => {
        vi.mocked(NotesAPIModule.NotesAPI.listTags).mockResolvedValue(['tag1', 'tag2']);

        render(<NotesSidebarSearch />);

        // 点击过滤器按钮打开弹窗
        const filterButtons = screen.getAllByTestId('notion-button');
        const filterButton = filterButtons[0]; // 第一个按钮是过滤器按钮
        fireEvent.click(filterButton);

        // 等待弹窗内容渲染
        await waitFor(() => {
            expect(screen.getByTestId('popover-content')).toBeInTheDocument();
        });

        // 点击标签
        const badges = screen.getAllByTestId('badge');
        const tag1Badge = badges.find(b => b.textContent?.includes('tag1'));
        if (tag1Badge) {
            fireEvent.click(tag1Badge);
        }

        // 验证搜索被调用（使用标签搜索格式）
        await waitFor(() => {
            expect(mockPerformSearch).toHaveBeenCalledWith('', ['tag1']);
        });
    });

    it('应该能选择多个标签', async () => {
        vi.mocked(NotesAPIModule.NotesAPI.listTags).mockResolvedValue(['tag1', 'tag2', 'tag3']);

        render(<NotesSidebarSearch />);

        // 打开过滤器
        const filterButtons = screen.getAllByTestId('notion-button');
        const filterButton = filterButtons[0];
        fireEvent.click(filterButton);

        // 选择多个标签
        await waitFor(() => {
            const badges = screen.getAllByTestId('badge');
            badges.forEach(badge => {
                const text = badge.textContent || '';
                if (text.includes('tag1') || text.includes('tag2')) {
                    fireEvent.click(badge);
                }
            });
        });

        // 验证组合搜索被调用
        await waitFor(() => {
            expect(mockPerformSearch).toHaveBeenCalledWith('', ['tag1', 'tag2']);
        });
    });

    it('应该显示已选择的标签', async () => {
        vi.mocked(NotesAPIModule.NotesAPI.listTags).mockResolvedValue(['tag1']);

        render(<NotesSidebarSearch />);

        // 打开过滤器并选择标签
        const filterButtons = screen.getAllByTestId('button');
        const filterButton = filterButtons[0];
        fireEvent.click(filterButton);

        await waitFor(() => {
            const tag1Badge = screen.getAllByTestId('badge').find(b => b.textContent?.includes('tag1'));
            if (tag1Badge) {
                fireEvent.click(tag1Badge);
            }
        });

        // 验证已选择的标签显示
        await waitFor(() => {
            expect(screen.getByText('tag1')).toBeInTheDocument();
        });
    });
});
