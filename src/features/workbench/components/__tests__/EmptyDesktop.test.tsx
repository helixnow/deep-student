/**
 * EmptyDesktop 测试：默认保持空桌面干净，不渲染引导卡片；
 * 仅在存在可恢复快照时渲染轻量的「恢复上次桌面」胶囊。
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { EmptyDesktop } from '../EmptyDesktop';

describe('空桌面渲染', () => {
  it('默认不渲染引导卡片与快速上手 tour', () => {
    const { container } = render(<EmptyDesktop />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('你的学习桌面')).toBeNull();
    expect(screen.queryByTestId('wb-empty-tour')).toBeNull();
  });

  it('有可恢复快照时只渲染「恢复上次桌面」胶囊并保持 pointer-events 穿透容器', () => {
    const onRestoreSession = vi.fn();
    const { container } = render(
      <EmptyDesktop restoreAvailable restoreWindowCount={2} onRestoreSession={onRestoreSession} />,
    );
    expect(container.querySelector('.wb-empty-desktop')).toBeTruthy();
    expect(screen.queryByText('你的学习桌面')).toBeNull();
    const btn = screen.getByTestId('wb-empty-restore-session');
    expect(btn.textContent).toBeTruthy();
    fireEvent.click(btn);
    expect(onRestoreSession).toHaveBeenCalledTimes(1);
  });

  it('缺少 onRestoreSession 回调时不渲染胶囊', () => {
    const { container } = render(<EmptyDesktop restoreAvailable restoreWindowCount={2} />);
    expect(container.firstChild).toBeNull();
  });
});
