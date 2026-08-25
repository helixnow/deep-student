import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { revealMock } = vi.hoisted(() => ({
  revealMock: vi.fn(() => () => {}),
}));

vi.mock('../settingsSearchReveal', () => ({
  revealSettingsSection: revealMock,
  SETTINGS_MAIN_CONTENT_ID: 'settings-main-content',
  SETTINGS_SEARCH_HIT_CLASS: 'settings-search-hit',
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { SettingsSidebar } from '../SettingsSidebar';

const DummyIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} aria-hidden />
);

const SEARCH_INDEX = [
  { label: '主题', keywords: ['theme', 'dark'], tab: 'appearance' },
  { label: '主题色', keywords: ['accent'], tab: 'appearance' },
  { label: '界面语言', keywords: ['language'], tab: 'general' },
];

const NAV_ITEMS = [
  { value: 'general', label: '通用', icon: DummyIcon },
  { value: 'appearance', label: '外观', icon: DummyIcon },
];

function Harness({
  setActiveTab,
  setSidebarOpen = () => {},
  isSmallScreen = false,
}: {
  setActiveTab: (tab: string) => void;
  setSidebarOpen?: (open: boolean) => void;
  isSmallScreen?: boolean;
}) {
  const [query, setQuery] = useState('');
  return (
    <SettingsSidebar
      isSmallScreen={isSmallScreen}
      globalLeftPanelCollapsed={false}
      sidebarSearchQuery={query}
      setSidebarSearchQuery={setQuery}
      sidebarSearchFocused={false}
      setSidebarSearchFocused={() => {}}
      settingsSearchIndex={SEARCH_INDEX}
      sidebarNavItems={NAV_ITEMS}
      activeTab="general"
      setActiveTab={setActiveTab}
      setSidebarOpen={setSidebarOpen}
    />
  );
}

function getSearchInput(): HTMLInputElement {
  return screen.getByRole('combobox', { name: '搜索设置...' }) as HTMLInputElement;
}

describe('SettingsSidebar 搜索键盘交互与空态', () => {
  beforeEach(() => {
    revealMock.mockClear();
  });

  it('输入关键词列出命中项，↑/↓ 移动高亮并同步 aria-activedescendant', () => {
    render(<Harness setActiveTab={vi.fn()} />);
    const input = getSearchInput();

    fireEvent.change(input, { target: { value: '主题' } });

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAccessibleName(/主题/);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);

    // 末项继续 ↓ 不越界
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'End' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Home' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter 激活高亮项：切换 tab、触发内容区定位、清空搜索', () => {
    const setActiveTab = vi.fn();
    render(<Harness setActiveTab={setActiveTab} />);
    const input = getSearchInput();

    fireEvent.change(input, { target: { value: '主题' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(setActiveTab).toHaveBeenCalledWith('appearance');
    expect(revealMock).toHaveBeenCalledWith('主题色');
    // 搜索清空后回到导航列表
    expect(input.value).toBe('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByText('通用')).toBeInTheDocument();
  });

  it('查询变化后高亮索引复位到首项', () => {
    render(<Harness setActiveTab={vi.fn()} />);
    const input = getSearchInput();

    fireEvent.change(input, { target: { value: '主题' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.change(input, { target: { value: '语言' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('Escape 清空搜索并回到导航列表', () => {
    render(<Harness setActiveTab={vi.fn()} />);
    const input = getSearchInput();

    fireEvent.change(input, { target: { value: '主题' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('外观')).toBeInTheDocument();
  });

  it('纯空白输入给「输入关键词」提示而非无结果报错', () => {
    const { container } = render(<Harness setActiveTab={vi.fn()} />);
    const input = getSearchInput();

    fireEvent.change(input, { target: { value: '   ' } });

    const prompt = container.querySelector('[data-settings-search-empty="prompt"]');
    expect(prompt).not.toBeNull();
    expect(within(prompt as HTMLElement).getByText('输入关键词以搜索设置')).toBeInTheDocument();
    expect(container.querySelector('[data-settings-search-empty="no-results"]')).toBeNull();
  });

  it('无结果空态展示提示与「清空搜索」出口', () => {
    const { container } = render(<Harness setActiveTab={vi.fn()} />);
    const input = getSearchInput();

    fireEvent.change(input, { target: { value: '不存在的设置项' } });

    const empty = container.querySelector('[data-settings-search-empty="no-results"]');
    expect(empty).not.toBeNull();
    expect(within(empty as HTMLElement).getByText('未找到匹配的设置')).toBeInTheDocument();

    fireEvent.click(within(empty as HTMLElement).getByRole('button', { name: /清空搜索/ }));
    expect(input.value).toBe('');
    expect(screen.getByText('通用')).toBeInTheDocument();
  });

  it('无结果时 Enter/↑/↓ 不产生副作用', () => {
    const setActiveTab = vi.fn();
    render(<Harness setActiveTab={setActiveTab} />);
    const input = getSearchInput();

    fireEvent.change(input, { target: { value: '不存在的设置项' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(setActiveTab).not.toHaveBeenCalled();
    expect(revealMock).not.toHaveBeenCalled();
  });

  it('小屏下 Enter 激活后收起侧栏', () => {
    const setSidebarOpen = vi.fn();
    render(<Harness setActiveTab={vi.fn()} setSidebarOpen={setSidebarOpen} isSmallScreen />);
    const input = getSearchInput();

    fireEvent.change(input, { target: { value: '语言' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });
});
