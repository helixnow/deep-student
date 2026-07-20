/**
 * 搜索栏组件单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { NotesSidebarSearch } from '../components/NotesSidebarSearch';
import * as NotesContextModule from '../NotesContext';
import * as NotesAPIModule from '@/utils/notesApi';

// Mock useNotes
vi.mock('../NotesContext', () => ({
    useNotes: vi.fn(() => ({
        performSearch: vi.fn(),
        setSearchQuery: vi.fn(),
        searchQuery: '',
    })),
}));

// Mock NotesAPI
vi.mock('@/utils/notesApi', () => ({
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
    [key: string]: unknown;
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
    onClick?: () => void;
}

// Mock UI components
vi.mock('@/components/ui/shad/Input', () => ({
    Input: React.forwardRef<HTMLInputElement, MockInputProps>(({ value, onChange, placeholder, ...props }, ref) => (
        <input ref={ref} data-testid="search-input" value={value} onChange={onChange} placeholder={placeholder} {...props} />
    )),
}));

vi.mock('@/components/ui/DsButton', () => ({
    DsButton: ({ children, onClick, className, ...props }: MockButtonProps & { [key: string]: unknown }) => (
        <button data-testid="card-button" onClick={onClick} className={className} {...props}>
            {children}
        </button>
    ),
}));

vi.mock('@/components/ui/shad/Popover', () => ({
    Popover: ({ children, open, onOpenChange }: MockPopoverProps) => (
        <div data-testid="popover" data-open={open} onClick={() => onOpenChange?.(!open)}>
            {children}
        </div>
    ),
    PopoverContent: ({ children }: { children?: React.ReactNode }) => <div data-testid="popover-content">{children}</div>,
    PopoverTrigger: ({ children }: { children?: React.ReactNode }) => <div data-testid="popover-trigger">{children}</div>,
}));

vi.mock('@/components/ui/shad/Badge', () => ({
    Badge: ({ children, className, onClick }: MockBadgeProps) => (
        <div data-testid="badge" className={className} onClick={onClick}>{children}</div>
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
        vi.mocked(NotesAPIModule.NotesAPI.listTags).mockResolvedValue([]);
    });

    it('应该正确渲染搜索输入框', () => {
        render(<NotesSidebarSearch />);

        expect(screen.getByTestId('search-input')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('notes:sidebar.search.search_placeholder')).toBeInTheDocument();
    });

    it('根节点应带有 notes-sidebar-search class（命令面板聚焦依赖）', () => {
        const { container } = render(<NotesSidebarSearch />);

        const root = container.querySelector('.notes-sidebar-search');
        expect(root).not.toBeNull();
        // 命令面板通过 `.notes-sidebar-search input` 定位输入框
        expect(root?.querySelector('input')).not.toBeNull();
    });

    describe('搜索结果键盘导航', () => {
        it('输入词存在时 ↑/↓/Enter 应触发导航回调', () => {
            const onResultNavigate = vi.fn();
            const onResultSubmit = vi.fn();
            render(
                <NotesSidebarSearch
                    onResultNavigate={onResultNavigate}
                    onResultSubmit={onResultSubmit}
                />,
            );

            const input = screen.getByTestId('search-input');
            fireEvent.change(input, { target: { value: 'query' } });

            fireEvent.keyDown(input, { key: 'ArrowDown' });
            expect(onResultNavigate).toHaveBeenCalledWith(1);

            fireEvent.keyDown(input, { key: 'ArrowUp' });
            expect(onResultNavigate).toHaveBeenCalledWith(-1);

            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onResultSubmit).toHaveBeenCalledTimes(1);
        });

        it('输入为空时不应触发导航回调', () => {
            const onResultNavigate = vi.fn();
            const onResultSubmit = vi.fn();
            render(
                <NotesSidebarSearch
                    onResultNavigate={onResultNavigate}
                    onResultSubmit={onResultSubmit}
                />,
            );

            const input = screen.getByTestId('search-input');
            fireEvent.keyDown(input, { key: 'ArrowDown' });
            fireEvent.keyDown(input, { key: 'Enter' });

            expect(onResultNavigate).not.toHaveBeenCalled();
            expect(onResultSubmit).not.toHaveBeenCalled();
        });
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

        const clearButton = screen.getAllByTestId('card-button').at(-1);
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
        const filterButtons = screen.getAllByTestId('card-button');
        const filterButton = filterButtons.find(btn => btn.querySelector('svg'));
        if (filterButton) {
            fireEvent.click(filterButton);
        }

        // 等待标签加载
        await waitFor(() => {
            expect(NotesAPIModule.NotesAPI.listTags).toHaveBeenCalled();
            expect(screen.getByText('tag1')).toBeInTheDocument();
        });
    });

    it('应该能按标签过滤', async () => {
        vi.mocked(NotesAPIModule.NotesAPI.listTags).mockResolvedValue(['tag1', 'tag2']);

        render(<NotesSidebarSearch />);

        // 点击过滤器按钮打开弹窗
        const filterButtons = screen.getAllByTestId('card-button');
        const filterButton = filterButtons[0]; // 第一个按钮是过滤器按钮
        fireEvent.click(filterButton);

        // 等待弹窗内容渲染
        await waitFor(() => {
            expect(screen.getByTestId('popover-content')).toBeInTheDocument();
            expect(screen.getByText('tag1')).toBeInTheDocument();
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
        const filterButtons = screen.getAllByTestId('card-button');
        const filterButton = filterButtons[0];
        fireEvent.click(filterButton);

        await waitFor(() => {
            expect(screen.getByText('tag1')).toBeInTheDocument();
            expect(screen.getByText('tag2')).toBeInTheDocument();
        });

        const tag1Badge = screen.getAllByTestId('badge').find(b => b.textContent?.includes('tag1'));
        if (!tag1Badge) {
            throw new Error('tag1 badge not found');
        }
        fireEvent.click(tag1Badge);

        await waitFor(() => {
            expect(mockPerformSearch).toHaveBeenCalledWith('', ['tag1']);
        });

        const tag2Badge = screen.getAllByTestId('badge').find(b => b.textContent?.includes('tag2'));
        if (!tag2Badge) {
            throw new Error('tag2 badge not found');
        }
        fireEvent.click(tag2Badge);

        // 验证组合搜索被调用
        await waitFor(() => {
            expect(mockPerformSearch).toHaveBeenCalledWith('', ['tag1', 'tag2']);
        });
    });

    it('应该显示已选择的标签', async () => {
        vi.mocked(NotesAPIModule.NotesAPI.listTags).mockResolvedValue(['tag1']);

        render(<NotesSidebarSearch />);

        // 打开过滤器并选择标签
        const filterButtons = screen.getAllByTestId('card-button');
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
            expect(screen.getAllByText('tag1').length).toBeGreaterThan(0);
        });
    });
});
