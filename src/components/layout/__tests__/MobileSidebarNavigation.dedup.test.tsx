/**
 * 移动抽屉全局应用入口契约：
 * 1. head 之下固定启动器网格（3 列，7 个入口），不随页内列表滚动。
 * 2. 不含搜索与命令、总览；制卡任务与模板并入「闪卡」（闪卡中心页内分区切换）。
 *    格子文案：会话 / 资源 / 音视频 / 待办 / 技能 / 闪卡 / 数据（音视频为产品名，不缩写）。
 * 3. 当前视图高亮，不从网格里拿掉；闪卡中心任一分区活跃时「闪卡」高亮。
 */
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useViewStore } from '@/stores/viewStore';
import type { CurrentView } from '@/types/navigation';
import { MOBILE_APP_LAUNCHER_VIEWS } from '@/config/navigation';
import { rememberCardsHubView, resetCardsHubMemoryForTests } from '@/app/navigation/cardsHub';

import { MobileSidebarNavigation } from '../MobileSidebarNavigation';

const setCurrentView = (view: CurrentView) => {
  useViewStore.setState({ currentView: view, previousView: null });
};

const getButtonLabels = () =>
  screen.getAllByRole('button').map((el) => el.textContent?.trim());

describe('MobileSidebarNavigation app launcher', () => {
  beforeEach(() => {
    cleanup();
    resetCardsHubMemoryForTests();
    setCurrentView('chat-v2');
  });

  it('renders the seven launcher destinations as a 3-column grid', () => {
    render(<MobileSidebarNavigation />);

    expect(MOBILE_APP_LAUNCHER_VIEWS).toEqual([
      'chat-v2',
      'learning-hub',
      'media',
      'todo',
      'skills-management',
      'flashcards',
      'data-management',
    ]);
    expect(screen.getByRole('navigation').getAttribute('data-mobile-app-launcher')).toBe('');
    expect(getButtonLabels()).toEqual([
      '会话',
      '资源',
      '音视频',
      '待办',
      '技能',
      '闪卡',
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
    expect(screen.getByRole('button', { name: '资源库' })).toBeTruthy();
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

  it('opens the flashcards hub on the review tab by default', () => {
    const onNavigate = vi.fn();
    render(<MobileSidebarNavigation onNavigate={onNavigate} />);

    expect(screen.queryByRole('button', { name: 'Anki制卡' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '闪卡' }));

    expect(onNavigate).toHaveBeenCalledWith('flashcards');
  });

  it('reopens the last visited flashcards hub tab from outside the hub', () => {
    rememberCardsHubView('template-management');
    const onNavigate = vi.fn();
    render(<MobileSidebarNavigation onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: '闪卡' }));

    expect(onNavigate).toHaveBeenCalledWith('template-management');
  });

  it.each(['flashcards', 'task-dashboard', 'template-management'] as const)(
    'highlights the flashcards tile and keeps the current tab when %s is active',
    (view) => {
      setCurrentView(view);
      const onNavigate = vi.fn();
      render(<MobileSidebarNavigation onNavigate={onNavigate} />);

      const tile = screen.getByRole('button', { name: '闪卡' });
      expect(tile).toHaveAttribute('aria-current', 'page');
      fireEvent.click(tile);
      expect(onNavigate).toHaveBeenCalledWith(view);
    },
  );
});

describe('MobileSidebarNavigation media launcher', () => {
  beforeEach(() => {
    cleanup();
    setCurrentView('chat-v2');
  });

  it('navigates to the media sub-app and marks it current there', () => {
    const onNavigate = vi.fn();
    render(<MobileSidebarNavigation onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: '音视频' }));
    expect(onNavigate).toHaveBeenCalledWith('media');
    cleanup();

    setCurrentView('media');
    render(<MobileSidebarNavigation />);
    expect(screen.getByRole('button', { name: '音视频' })).toHaveAttribute('aria-current', 'page');
  });
});
