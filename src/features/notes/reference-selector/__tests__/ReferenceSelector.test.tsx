/**
 * ReferenceSelector（锚定内联面板版）单元测试
 *
 * 覆盖：
 * - 打开时仅发起一次加载请求（原 Dialog 版存在双重请求 bug）
 * - 列表 listbox/option 语义
 * - 单击条目即选中确认（无二步 Confirm）
 * - ↑↓ + Enter 键盘确认；Esc 收起
 * - 已引用条目禁用
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReferenceSelector } from '../ReferenceSelector';
import { listTextbooks } from '../api';

vi.mock('../api', () => ({
    listTextbooks: vi.fn(),
    listExamSessions: vi.fn(),
}));

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}));

vi.mock('@tauri-apps/api/core', () => ({
    convertFileSrc: (path: string) => `asset://mock${path}`,
}));

vi.mock('@/components/ui/DsButton', () => ({
    DsButton: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
        ({ children, ...props }, ref) => {
            // 过滤非 DOM 属性
            const { ...rest } = props as Record<string, unknown>;
            delete rest.iconOnly;
            delete rest.variant;
            delete rest.size;
            return <button ref={ref} {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>;
        }
    ),
}));

vi.mock('@/components/ui/shad/Input', () => ({
    Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
        (props, ref) => <input ref={ref} data-testid="search-input" {...props} />
    ),
}));

vi.mock('@/components/custom-scroll-area', () => ({
    CustomScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const ok = <T,>(value: T) => ({ ok: true as const, value });

const sampleBooks = [
    { id: 'book-1', title: '高等数学', updatedAt: Date.now() },
    { id: 'book-2', title: '线性代数', updatedAt: Date.now() },
];

describe('ReferenceSelector (anchored inline panel)', () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listTextbooks).mockResolvedValue(ok(sampleBooks) as Awaited<ReturnType<typeof listTextbooks>>);
    });

    it('打开时只发起一次加载请求', async () => {
        render(
            <ReferenceSelector
                open
                onOpenChange={onOpenChange}
                type="textbook"
                onSelect={onSelect}
            />
        );

        await waitFor(() => {
            expect(screen.getByRole('listbox')).toBeInTheDocument();
        });

        // 等待超过搜索防抖窗口，确认没有第二次请求
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(listTextbooks).toHaveBeenCalledTimes(1);
    });

    it('以非模态浮层渲染（无遮罩），列表为 listbox/option', async () => {
        render(
            <ReferenceSelector
                open
                onOpenChange={onOpenChange}
                type="textbook"
                onSelect={onSelect}
            />
        );

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'false');

        const options = await screen.findAllByRole('option');
        expect(options).toHaveLength(2);
    });

    it('单击条目即选中确认并收起（无二步 Confirm）', async () => {
        render(
            <ReferenceSelector
                open
                onOpenChange={onOpenChange}
                type="textbook"
                onSelect={onSelect}
            />
        );

        const option = await screen.findByText('高等数学');
        fireEvent.click(option);

        expect(onSelect).toHaveBeenCalledWith({
            sourceDb: 'textbooks',
            sourceId: 'book-1',
            title: '高等数学',
            previewType: 'pdf',
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('支持 ↑↓ 移动高亮、Enter 确认', async () => {
        render(
            <ReferenceSelector
                open
                onOpenChange={onOpenChange}
                type="textbook"
                onSelect={onSelect}
            />
        );

        await screen.findAllByRole('option');
        const input = screen.getByTestId('search-input');

        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(onSelect).toHaveBeenCalledWith(
            expect.objectContaining({ sourceId: 'book-2' })
        );
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('Esc 收起面板', async () => {
        render(
            <ReferenceSelector
                open
                onOpenChange={onOpenChange}
                type="textbook"
                onSelect={onSelect}
            />
        );

        await screen.findAllByRole('option');
        fireEvent.keyDown(document, { key: 'Escape' });

        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('已引用条目禁用且不可选中', async () => {
        render(
            <ReferenceSelector
                open
                onOpenChange={onOpenChange}
                type="textbook"
                onSelect={onSelect}
                existingRefs={[{ sourceDb: 'textbooks', sourceId: 'book-1' }]}
            />
        );

        const options = await screen.findAllByRole('option');
        const referenced = options.find(o => o.textContent?.includes('高等数学'));
        expect(referenced).toHaveAttribute('aria-disabled', 'true');

        if (referenced) fireEvent.click(referenced);
        expect(onSelect).not.toHaveBeenCalled();
    });
});
