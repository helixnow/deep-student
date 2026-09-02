/**
 * 移动抽屉全局应用入口契约：
 * 1. head 之下固定二行三列六个入口，不随页内列表滚动。
 * 2. 不含搜索与命令、总览、模板管理；格子文案两字：会话 / 资源 / 待办 / 技能 / 制卡 / 数据。
 * 3. 当前视图高亮，不从网格里拿掉。
 */
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useViewStore } from '@/stores/viewStore';
import type { CurrentView } from '@/types/navigation';
import { MOBILE_APP_LAUNCHER_VIEWS } from '@/config/navigation';

import { MobileSidebarNavigation } from '../MobileSidebarNavigation';

const setCurrentView = (view: CurrentView) => {
  useViewStore.setState({ currentView: view, previousView: null });
};

const getButtonLabels = () =>
  screen.getAllByRole('button').map((el) => el.textContent?.trim());

describe('MobileSidebarNavigation app launcher', () => {
  beforeEach(() => {
    cleanup();
    setCurrentView('chat-v2');
  });

  it('renders the six launcher destinations as a 2x3 grid', () => {
    render(<MobileSidebarNavigation />);

    expect(MOBILE_APP_LAUNCHER_VIEWS).toEqual([
      'chat-v2',
      'learning-hub',
      'todo',
      'skills-management',
      'task-dashboard',
      'data-management',
    ]);
    expect(screen.getByRole('navigation').getAttribute('data-mobile-app-launcher')).toBe('');
    expect(getButtonLabels()).toEqual([
      '会话',
      '资源',
      '待办',
      '技能',
      '制卡',
      '数据',
    ]);
  });

  it('does not expose search, overview, templates, or settings in the launcher', () => {
    render(<MobileSidebarNavigation />);

    expect(screen.queryByRole('button', { name: '搜索与命令' })).toBeNull();
    expect(screen.queryByRole('button', { name: '总览' })).toBeNull();
    expect(screen.queryByRole('button', { name: '模板管理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '设置' })).toBeNull();
  });

  it('keeps the current-view tile visible and marked current', () => {
    setCurrentView('chat-v2');
    render(<MobileSidebarNavigation />);

    expect(screen.getByRole('button', { name: '会话' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '学习资源' })).toBeTruthy();
  });

  it('highlights data management when the deprecated dashboard view is current', () => {
    setCurrentView('dashboard');
    render(<MobileSidebarNavigation />);

    expect(screen.getByRole('button', { name: '数据管理' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: '总览' })).toBeNull();
  });

  it('renders every launcher label at most once', () => {
    render(<MobileSidebarNavigation />);

    const labels = getButtonLabels();
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('can reserve settings for the drawer header', () => {
    render(<MobileSidebarNavigation hideSettings />);
    expect(screen.queryByRole('button', { name: '设置' })).toBeNull();
    cleanup();

    render(<MobileSidebarNavigation settingsOnly />);
    expect(screen.getAllByRole('button', { name: '设置' })).toHaveLength(1);
  });

  it('passes the settings target so the caller can preserve the expanded drawer', () => {
    const onNavigate = vi.fn();
    render(<MobileSidebarNavigation settingsOnly onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    expect(onNavigate).toHaveBeenCalledWith('settings');
  });

  it('navigates to Anki card making from the launcher', () => {
    const onNavigate = vi.fn();
    render(<MobileSidebarNavigation onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Anki制卡' }));

    expect(onNavigate).toHaveBeenCalledWith('task-dashboard');
  });
});
