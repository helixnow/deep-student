/**
 * 移动抽屉全局导航去重契约：
 * 1. 抽屉上方已渲染当前页面的页内工具（如 Chat 页的「新对话/所有对话」），
 *    全局导航不得再渲染指向当前视图的重复入口（如「新会话」）。
 * 2. 集合去重：createNavItems 与移动端手工追加项（总览/数据管理）若指向
 *    同一 canonicalizeView 归一化后的视图（含废弃别名），只允许渲染一次。
 */
import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ChartBar } from '@phosphor-icons/react';
import { useViewStore } from '@/stores/viewStore';
import type { CurrentView } from '@/types/navigation';
import type { NavItem } from '@/config/navigation';

// 可注入的额外导航项：模拟 createNavItems 未来直接包含 dashboard /
// data-management（或其废弃别名）时，抽屉不得与移动端手工追加项重复。
const mockState = vi.hoisted(() => ({
  extraNavItems: [] as Array<{ name: string; view: string; icon: React.ComponentType }>,
}));

vi.mock('@/config/navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/navigation')>();
  return {
    ...actual,
    createNavItems: (...args: Parameters<typeof actual.createNavItems>) => [
      ...actual.createNavItems(...args),
      ...(mockState.extraNavItems as unknown as NavItem[]),
    ],
  };
});

import { MobileSidebarNavigation } from '../MobileSidebarNavigation';

const setCurrentView = (view: CurrentView) => {
  useViewStore.setState({ currentView: view, previousView: null });
};

const getButtonLabels = () =>
  screen.getAllByRole('button').map((el) => el.textContent?.trim());

describe('MobileSidebarNavigation drawer dedup', () => {
  beforeEach(() => {
    cleanup();
    mockState.extraNavItems = [];
    setCurrentView('chat-v2');
  });

  it('hides the chat entry while on the chat page (page tools already provide it)', () => {
    setCurrentView('chat-v2');
    render(<MobileSidebarNavigation />);

    expect(screen.queryByRole('button', { name: '新会话' })).toBeNull();
    // 其余全局入口保持可见
    expect(screen.getByRole('button', { name: '学习资源' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy();
  });

  it('hides the learning hub entry while on the learning hub page', () => {
    setCurrentView('learning-hub');
    render(<MobileSidebarNavigation />);

    expect(screen.queryByRole('button', { name: '学习资源' })).toBeNull();
    expect(screen.getByRole('button', { name: '新会话' })).toBeTruthy();
  });

  it('hides the mobile-only dashboard entry while on the dashboard page', () => {
    setCurrentView('dashboard');
    render(<MobileSidebarNavigation />);

    expect(screen.queryByRole('button', { name: '总览' })).toBeNull();
    expect(screen.getByRole('button', { name: '数据管理' })).toBeTruthy();
  });

  it('renders every entry at most once', () => {
    setCurrentView('chat-v2');
    render(<MobileSidebarNavigation />);

    const labels = getButtonLabels();
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });

  it('does not duplicate mobile-only entries when createNavItems already includes them', () => {
    // 回归场景：createNavItems 直接提供 dashboard / data-management 时，
    // 移动端手工追加项必须按 canonical view 去重，不得出现两次。
    mockState.extraNavItems = [
      { name: '总览', view: 'dashboard', icon: ChartBar },
      { name: '数据管理', view: 'data-management', icon: ChartBar },
    ];
    setCurrentView('chat-v2');
    render(<MobileSidebarNavigation />);

    expect(screen.getAllByRole('button', { name: '总览' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '数据管理' })).toHaveLength(1);

    const labels = getButtonLabels();
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('dedups by canonical view even when a deprecated alias points at the same page', () => {
    // llm-usage-stats 经 canonicalizeView 归一化后即 dashboard：
    // 集合去重必须发生在归一化之后，别名入口与「总览」不得同时出现。
    mockState.extraNavItems = [
      { name: '用量统计', view: 'llm-usage-stats', icon: ChartBar },
    ];
    setCurrentView('chat-v2');
    render(<MobileSidebarNavigation />);

    const aliasButtons = screen.getAllByRole('button', { name: '用量统计' });
    expect(aliasButtons).toHaveLength(1);
    // 首次出现者保留（createNavItems 的别名项），手工追加的「总览」被去重
    expect(screen.queryByRole('button', { name: '总览' })).toBeNull();
  });

  it('still hides duplicated createNavItems entries pointing at the current view', () => {
    mockState.extraNavItems = [
      { name: '总览', view: 'dashboard', icon: ChartBar },
    ];
    setCurrentView('dashboard');
    render(<MobileSidebarNavigation />);

    // 当前视图入口（无论来自 createNavItems 还是手工追加）一律不渲染
    expect(screen.queryByRole('button', { name: '总览' })).toBeNull();
  });

  it('can reserve settings for the drawer header without duplicating it in the scroll area', () => {
    render(<MobileSidebarNavigation hideSettings />);

    expect(screen.queryByRole('button', { name: '设置' })).toBeNull();
    cleanup();

    render(<MobileSidebarNavigation settingsOnly />);
    expect(screen.getAllByRole('button', { name: '设置' })).toHaveLength(1);
  });

  it('passes the settings target so the caller can preserve the expanded drawer', () => {
    const onNavigate = vi.fn();
    render(<MobileSidebarNavigation onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    expect(onNavigate).toHaveBeenCalledWith('settings');
  });
});
