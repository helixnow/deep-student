/**
 * EmptyDesktop 测试：首次使用轻提示 + 单主 CTA；关闭后完全消隐。
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
  it('渲染标题 / 提示 / 单主 CTA', () => {
    render(<EmptyDesktop />);
    expect(screen.getByText('你的学习桌面')).toBeTruthy();
    expect(screen.getByRole('group', { name: '快速开始' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /打开资源库/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /打开资源库/ })).toHaveLength(1);
  });

  it('整层用 wb-empty-desktop 类（基线 pointer-events:none，不挡桌面右键）', () => {
    const { container } = render(<EmptyDesktop />);
    expect(container.querySelector('.wb-empty-desktop')).toBeTruthy();
    // 可点区域仅 CTA 块 / onboarding（CSS pointer-events: auto），非整层拦截
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

describe('首次使用 onboarding', () => {
  it('首次展示技巧列表', () => {
    render(<EmptyDesktop />);
    expect(screen.getByText('小技巧')).toBeTruthy();
    expect(screen.getByText('把窗口拖到屏幕边缘，松手即可平铺')).toBeTruthy();
    expect(screen.getByText('在窗口间快速切换')).toBeTruthy();
    expect(screen.getByText('俯瞰所有打开的窗口')).toBeTruthy();
  });

  it('点「知道了」→ 隐藏并写入 localStorage', () => {
    render(<EmptyDesktop />);
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByText('你的学习桌面')).toBeNull();
    expect(localStorage.getItem(EMPTY_DESKTOP_ONBOARDING_KEY)).toBe('1');
  });

  it('已关闭过 → 重新挂载不再展示', () => {
    localStorage.setItem(EMPTY_DESKTOP_ONBOARDING_KEY, '1');
    render(<EmptyDesktop />);
    expect(screen.queryByText('你的学习桌面')).toBeNull();
    expect(screen.queryByRole('button', { name: /打开资源库/ })).toBeNull();
  });
});
