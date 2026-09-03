/**
 * ContentEmptyState a11y 契约
 *
 * 锁定可达性语义，不锁视觉 token：
 * - 标题必须是真 heading（h2），保留 wb-content-empty__title 视觉类
 * - 容器是命名 region（aria-labelledby 指向标题），不再是 role="note"
 * - 装饰图标对读屏隐藏
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContentEmptyState } from '../ContentEmptyState';

describe('ContentEmptyState a11y 契约', () => {
  it('标题是 level-2 heading，并保留现有视觉类名', () => {
    render(<ContentEmptyState title="缺少资源标识" description="请从资源库重新打开" />);
    const heading = screen.getByRole('heading', { level: 2, name: '缺少资源标识' });
    expect(heading).toHaveClass('wb-content-empty__title');
    expect(screen.getByText('请从资源库重新打开')).toHaveClass('wb-content-empty__desc');
  });

  it('容器是 region，可访问名称来自标题（aria-labelledby）', () => {
    render(<ContentEmptyState title="缺少资源标识" />);
    const region = screen.getByRole('region', { name: '缺少资源标识' });
    expect(region).toHaveClass('wb-content-empty');
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.id).not.toBe('');
    expect(region).toHaveAttribute('aria-labelledby', heading.id);
  });

  it('不再使用 role="note"，装饰图标对读屏隐藏', () => {
    const { container } = render(<ContentEmptyState title="缺少资源标识" />);
    expect(container.querySelector('[role="note"]')).toBeNull();
    expect(container.querySelector('.wb-content-empty__icon')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('自定义 className 仍然透传到容器', () => {
    render(<ContentEmptyState title="缺少资源标识" className="custom-empty" />);
    expect(screen.getByRole('region', { name: '缺少资源标识' })).toHaveClass(
      'wb-content-empty',
      'custom-empty',
    );
  });
});
