import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { revealMock } = vi.hoisted(() => ({ revealMock: vi.fn(() => () => {}) }));

vi.mock('../settingsSearchReveal', () => ({
  revealSettingsSection: revealMock,
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { SettingsCategoryHeader } from '../SettingsCategoryHeader';
import { SettingsMobileNavigation } from '../SettingsMobileNavigation';
import { SettingsSidebar } from '../SettingsSidebar';
import { useSettingsNavigation } from '../useSettingsNavigation';

const categories = [
  { label: '模型与 AI', defaultTab: 'apis' },
  { label: '应用体验', defaultTab: 'general' },
  { label: '输入与个性化', defaultTab: 'voice-input' },
  { label: '工具与扩展', defaultTab: 'mcp' },
  { label: '工作流与文档', defaultTab: 'automation' },
  { label: '数据与系统', defaultTab: 'statistics' },
];

function DesktopHarness({
  initialTab = 'apis',
  onTabChange = () => {},
}: {
  initialTab?: string;
  onTabChange?: (tab: string) => void;
}) {
  const navigation = useSettingsNavigation();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [query, setQuery] = useState('');
  const category = navigation.sidebarCategories.find((group) =>
    group.items.some((item) => item.value === activeTab));
  const changeTab = (tab: string) => {
    setActiveTab(tab);
    onTabChange(tab);
  };

  return (
    <>
      <div data-testid="desktop-sidebar">
        <SettingsSidebar
          isSmallScreen={false}
          globalLeftPanelCollapsed={false}
          sidebarSearchQuery={query}
          setSidebarSearchQuery={setQuery}
          sidebarSearchFocused={false}
          setSidebarSearchFocused={() => {}}
          settingsSearchIndex={navigation.settingsSearchIndex}
          sidebarNavItems={navigation.sidebarNavItems}
          sidebarCategories={navigation.sidebarCategories}
          activeTab={activeTab}
          setActiveTab={changeTab}
          setSidebarOpen={() => {}}
        />
      </div>
      {category && (
        <SettingsCategoryHeader
          category={category}
          activeTab={activeTab}
          onTabChange={changeTab}
          idPrefix="settings-integration"
        />
      )}
      <div
        role="tabpanel"
        id="settings-integration-panel"
        aria-labelledby={category ? `settings-integration-tab-${activeTab}` : undefined}
        aria-label={category ? undefined : '关于'}
        data-active-tab={activeTab}
      >
        {activeTab}
      </div>
    </>
  );
}

function MobileHarness({ onOpenTab = () => {} }: { onOpenTab?: (tab: string) => void }) {
  const navigation = useSettingsNavigation();
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState('');

  return (
    <>
      <SettingsMobileNavigation
        categories={navigation.sidebarCategories}
        items={navigation.sidebarNavItems}
        searchIndex={navigation.settingsSearchIndex}
        query={query}
        onQueryChange={setQuery}
        onOpenTab={(tab) => {
          setActiveTab(tab);
          onOpenTab(tab);
        }}
      />
      <output aria-label="opened setting">{activeTab}</output>
    </>
  );
}

describe('Settings navigation integration', () => {
  beforeEach(() => {
    revealMock.mockClear();
  });

  it('shows six desktop categories and keeps About in a separate version footer', () => {
    const { container } = render(<DesktopHarness />);
    const sidebar = screen.getByTestId('desktop-sidebar');
    const categoryList = container.querySelector('[data-settings-category-list]') as HTMLElement;
    const footer = container.querySelector('[data-settings-about-footer]') as HTMLElement;

    expect(within(categoryList).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(categories.map((category) => category.label));
    expect(within(sidebar).getAllByRole('button')).toHaveLength(7);
    expect(within(categoryList).queryByRole('button', { name: '关于' })).not.toBeInTheDocument();
    expect(within(footer).getByText(/^v\d+\./)).toBeInTheDocument();

    fireEvent.click(within(footer).getByRole('button', { name: '关于' }));

    expect(screen.getByRole('tabpanel', { name: '关于' })).toHaveAttribute('data-active-tab', 'about');
    expect(within(footer).getByRole('button', { name: '关于' })).toHaveAttribute('aria-current', 'page');
    expect(categoryList.querySelector('[aria-current="page"]')).toBeNull();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it.each(categories)('opens the existing $defaultTab tab when selecting $label', ({ label, defaultTab }) => {
    const onTabChange = vi.fn();
    render(<DesktopHarness initialTab="about" onTabChange={onTabChange} />);

    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(onTabChange).toHaveBeenCalledExactlyOnceWith(defaultTab);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-active-tab', defaultTab);
    expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('tablist', { name: label })).toBeInTheDocument();
  });

  it('switches only the active section while its parent category remains selected', () => {
    const onTabChange = vi.fn();
    render(<DesktopHarness onTabChange={onTabChange} />);

    fireEvent.click(screen.getByRole('tab', { name: '模型分配' }));

    expect(onTabChange).toHaveBeenCalledExactlyOnceWith('models');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByRole('tabpanel', { name: '模型分配' })).toHaveAttribute('data-active-tab', 'models');
    expect(screen.queryByRole('tabpanel', { name: '模型服务' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '模型分配' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: '模型与 AI' })).toHaveAttribute('aria-current', 'page');

    // Selecting the already active category must not reset its selected section.
    fireEvent.click(screen.getByRole('button', { name: '模型与 AI' }));
    expect(onTabChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-active-tab', 'models');
  });

  it('derives the category and selected child from an existing document-processing deep link', () => {
    render(<DesktopHarness initialTab="document-processing" />);

    expect(screen.getByRole('button', { name: '工作流与文档' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '模型与 AI' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('tab', { name: '文档处理' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '文档处理' })).toHaveAttribute('data-active-tab', 'document-processing');
  });

  it.each([
    { query: 'ocr', label: 'OCR 识别设置', breadcrumb: '工作流与文档 / 文档处理', category: '工作流与文档', tab: 'document-processing', section: '文档处理' },
    { query: 'theme', label: '主题', breadcrumb: '应用体验 / 外观', category: '应用体验', tab: 'appearance', section: '外观' },
  ])('searches $query across categories without changing the legacy tab or reveal label', (entry) => {
    const onTabChange = vi.fn();
    render(<DesktopHarness onTabChange={onTabChange} />);
    const input = screen.getByRole('combobox', { name: '搜索设置...' });

    fireEvent.change(input, { target: { value: entry.query } });
    const result = screen.getByRole('option', { name: `${entry.label} ${entry.breadcrumb}` });
    expect(within(result).getByText(entry.breadcrumb)).toBeInTheDocument();
    fireEvent.click(within(result).getByRole('button'));

    expect(onTabChange).toHaveBeenCalledExactlyOnceWith(entry.tab);
    expect(revealMock).toHaveBeenCalledExactlyOnceWith(entry.label);
    expect(input).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: entry.category })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('tab', { name: entry.section })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-active-tab', entry.tab);
  });

  it('shows the same six mobile categories and opens their existing default sections', () => {
    const onOpenTab = vi.fn();
    const { container } = render(<MobileHarness onOpenTab={onOpenTab} />);
    const categoryList = container.querySelector('[data-settings-category-list]') as HTMLElement;

    expect(within(categoryList).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(categories.map((category) => category.label));
    categories.forEach(({ label, defaultTab }) => {
      fireEvent.click(within(categoryList).getByRole('button', { name: label }));
      expect(onOpenTab).toHaveBeenLastCalledWith(defaultTab);
      expect(screen.getByLabelText('opened setting')).toHaveTextContent(defaultTab);
    });
    expect(revealMock).not.toHaveBeenCalled();
  });

  it('opens a mobile search result directly and reveals its original label', () => {
    const onOpenTab = vi.fn();
    render(<MobileHarness onOpenTab={onOpenTab} />);

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索设置...' }), { target: { value: 'ocr' } });
    const result = screen.getByRole('button', { name: 'OCR 识别设置 工作流与文档 / 文档处理' });
    expect(within(result).getByText('工作流与文档 / 文档处理')).toBeInTheDocument();
    fireEvent.click(result);

    expect(onOpenTab).toHaveBeenCalledExactlyOnceWith('document-processing');
    expect(screen.getByLabelText('opened setting')).toHaveTextContent('document-processing');
    expect(revealMock).toHaveBeenCalledExactlyOnceWith('OCR 识别设置');
  });

  it('keeps mobile About outside the categories and available during search', () => {
    const onOpenTab = vi.fn();
    const { container } = render(<MobileHarness onOpenTab={onOpenTab} />);
    const categoryList = container.querySelector('[data-settings-category-list]') as HTMLElement;
    expect(within(categoryList).queryByRole('button', { name: '关于' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索设置...' }), { target: { value: 'ocr' } });
    const footer = container.querySelector('[data-settings-about-footer]') as HTMLElement;
    expect(within(footer).getByText(/^v\d+\./)).toBeInTheDocument();
    fireEvent.click(within(footer).getByRole('button', { name: '关于' }));

    expect(onOpenTab).toHaveBeenCalledExactlyOnceWith('about');
    expect(screen.getByLabelText('opened setting')).toHaveTextContent('about');
    expect(revealMock).not.toHaveBeenCalled();
  });
});
