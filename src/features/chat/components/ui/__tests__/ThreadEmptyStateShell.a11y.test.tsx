/**
 * ThreadEmptyStateShell a11y 契约
 *
 * 锁定可达性语义，不锁视觉 token、不改空态内容模型：
 * - 内部 h2 有稳定 id，外层 section 通过 aria-labelledby 指向它
 * - section 因此暴露为命名 region，读屏用户能拿到区域名称
 * - 支持调用方传入自定义 titleId
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThreadEmptyStateShell } from '../ThreadEmptyStateShell';

describe('ThreadEmptyStateShell a11y 契约', () => {
  it('section 通过 aria-labelledby 指向内部 h2，暴露为命名 region', () => {
    render(<ThreadEmptyStateShell title="今天想学点什么？" description="随便问点什么开始" />);
    const heading = screen.getByRole('heading', { level: 2, name: '今天想学点什么？' });
    expect(heading.id).not.toBe('');

    const region = screen.getByRole('region', { name: '今天想学点什么？' });
    expect(region).toHaveAttribute('data-slot', 'thread-empty-state');
    expect(region).toHaveAttribute('aria-labelledby', heading.id);
  });

  it('支持传入自定义 titleId', () => {
    render(<ThreadEmptyStateShell title="欢迎" titleId="custom-empty-title" />);
    expect(screen.getByRole('heading', { level: 2, name: '欢迎' })).toHaveAttribute(
      'id',
      'custom-empty-title',
    );
    expect(screen.getByRole('region', { name: '欢迎' })).toHaveAttribute(
      'aria-labelledby',
      'custom-empty-title',
    );
  });

  it('品牌图标区保持对读屏隐藏', () => {
    const { container } = render(
      <ThreadEmptyStateShell title="欢迎" brandIcon={<svg data-testid="brand-svg" />} />,
    );
    expect(
      container.querySelector('[data-slot="thread-empty-brand"]'),
    ).toHaveAttribute('aria-hidden', 'true');
  });
});
