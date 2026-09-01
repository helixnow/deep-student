import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AppMenu, AppMenuContent, AppMenuGroup, AppMenuItem, AppMenuTrigger } from './AppMenu';

describe('AppMenu 可访问名（P3-9）', () => {
  it('下拉菜单未显式命名时，用触发器文本作为菜单可访问名', () => {
    render(
      <AppMenu>
        <AppMenuTrigger asChild>
          <button type="button">更多操作</button>
        </AppMenuTrigger>
        <AppMenuContent>
          <AppMenuGroup>
            <AppMenuItem>重命名</AppMenuItem>
          </AppMenuGroup>
        </AppMenuContent>
      </AppMenu>,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menu', { name: '更多操作' })).toBeInTheDocument();
  });

  it('触发器是纯图标按钮（aria-label）时，菜单继承该 label', () => {
    render(
      <AppMenu>
        <AppMenuTrigger asChild>
          <button type="button" aria-label="分组操作">
            <svg aria-hidden />
          </button>
        </AppMenuTrigger>
        <AppMenuContent>
          <AppMenuItem>归档</AppMenuItem>
        </AppMenuContent>
      </AppMenu>,
    );

    fireEvent.click(screen.getByRole('button', { name: '分组操作' }));
    expect(screen.getByRole('menu', { name: '分组操作' })).toBeInTheDocument();
  });

  it('调用方显式 aria-label 优先于触发器兜底', () => {
    render(
      <AppMenu>
        <AppMenuTrigger asChild>
          <button type="button">打开</button>
        </AppMenuTrigger>
        <AppMenuContent aria-label="选择模型">
          <AppMenuItem>模型 A</AppMenuItem>
        </AppMenuContent>
      </AppMenu>,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(screen.getByRole('menu', { name: '选择模型' })).toBeInTheDocument();
  });

  it('context 模式不做触发器兜底（触发器是大面积内容区）', () => {
    render(
      <AppMenu mode="context">
        <AppMenuTrigger asChild>
          <div>会话行内容很长</div>
        </AppMenuTrigger>
        <AppMenuContent>
          <AppMenuItem>删除</AppMenuItem>
        </AppMenuContent>
      </AppMenu>,
    );

    fireEvent.contextMenu(screen.getByText('会话行内容很长'));
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(menu).not.toHaveAttribute('aria-labelledby');
  });
});
