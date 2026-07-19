/**
 * EmptyDesktop 测试：4 步 tour、跳过（会话）与不再显示（持久化）。
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { workbenchBus } from '../../core/workbenchBus';
import { EmptyDesktop, EMPTY_DESKTOP_ONBOARDING_KEY } from '../EmptyDesktop';

let launchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  launchSpy = vi.spyOn(workbenchBus, 'launch').mockReturnValue(null);
});

afterEach(() => {
  launchSpy.mockRestore();
});

describe('引导卡渲染', () => {
  it('渲染标题 / 提示 / 单主 CTA / tour', () => {
    render(<EmptyDesktop />);
    expect(screen.getByText('你的学习桌面')).toBeTruthy();
    expect(screen.getByRole('group', { name: '快速开始' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /打开资源库/ })).toBeTruthy();
    expect(screen.getByTestId('wb-empty-tour')).toBeTruthy();
    expect(screen.getByTestId('wb-empty-tour')).toHaveAttribute('data-tour-step', 'dock');
  });

  it('整层用 wb-empty-desktop 类（基线 pointer-events:none，不挡桌面右键）', () => {
    const { container } = render(<EmptyDesktop />);
    expect(container.querySelector('.wb-empty-desktop')).toBeTruthy();
    expect(container.querySelector('.wb-empty-cta-block')).toBeTruthy();
  });
});

describe('主 CTA', () => {
  it('点击主 CTA「打开资源库」→ launch files', () => {
    render(<EmptyDesktop />);
    fireEvent.click(screen.getByRole('button', { name: /打开资源库/ }));
    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'files', reason: 'api' });
  });
});

describe('4 步 tour', () => {
  it('下一步推进步骤；完成写入不再显示', () => {
    render(<EmptyDesktop />);
    const tour = screen.getByTestId('wb-empty-tour');
    expect(tour).toHaveAttribute('data-tour-step', 'dock');
    expect(screen.getByTestId('wb-empty-tour-progress').textContent).toMatch(/1/);

    fireEvent.click(screen.getByTestId('wb-empty-tour-next'));
    expect(tour).toHaveAttribute('data-tour-step', 'search');
    expect(screen.getByTestId('wb-empty-tour-progress').textContent).toMatch(/2/);

    fireEvent.click(screen.getByTestId('wb-empty-tour-next'));
    expect(tour).toHaveAttribute('data-tour-step', 'statusBar');

    fireEvent.click(screen.getByTestId('wb-empty-tour-next'));
    expect(tour).toHaveAttribute('data-tour-step', 'agent');
    expect(screen.getByTestId('wb-empty-tour-next').textContent).toMatch(/完成/);

    fireEvent.click(screen.getByTestId('wb-empty-tour-next'));
    expect(screen.queryByTestId('wb-empty-tour')).toBeNull();
    expect(localStorage.getItem(EMPTY_DESKTOP_ONBOARDING_KEY)).toBe('1');
  });

  it('不再显示 → 隐藏并写入 localStorage', () => {
    render(<EmptyDesktop />);
    fireEvent.click(screen.getByTestId('wb-empty-tour-dont-show'));
    expect(screen.queryByText('你的学习桌面')).toBeNull();
    expect(localStorage.getItem(EMPTY_DESKTOP_ONBOARDING_KEY)).toBe('1');
  });

  it('跳过仅本会话隐藏，不写入持久化', () => {
    const { unmount } = render(<EmptyDesktop />);
    fireEvent.click(screen.getByTestId('wb-empty-tour-skip'));
    expect(screen.queryByTestId('wb-empty-tour')).toBeNull();
    expect(localStorage.getItem(EMPTY_DESKTOP_ONBOARDING_KEY)).toBeNull();

    unmount();
    render(<EmptyDesktop />);
    expect(screen.getByTestId('wb-empty-tour')).toBeTruthy();
  });

  it('已关闭过 → 重新挂载不再展示', () => {
    localStorage.setItem(EMPTY_DESKTOP_ONBOARDING_KEY, '1');
    render(<EmptyDesktop />);
    expect(screen.queryByText('你的学习桌面')).toBeNull();
    expect(screen.queryByRole('button', { name: /打开资源库/ })).toBeNull();
  });
});
