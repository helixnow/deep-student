import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsCategoryHeader } from '../SettingsCategoryHeader';
import type { SettingsSidebarCategory } from '../useSettingsNavigation';

const DummyIcon = () => <svg aria-hidden="true" />;
const category: SettingsSidebarCategory = {
  value: 'models-ai',
  label: '模型与 AI',
  icon: DummyIcon,
  items: [
    { value: 'apis', label: '模型服务', icon: DummyIcon },
    { value: 'models', label: '模型分配', icon: DummyIcon },
    { value: 'params', label: '参数调整', icon: DummyIcon },
  ],
};

function Harness({
  initialTab = 'apis',
  onTabChange = () => {},
  compact = false,
}: {
  initialTab?: string;
  onTabChange?: (tab: string) => void;
  compact?: boolean;
}) {
  const [activeTab, setActiveTab] = useState(initialTab);
  return (
    <SettingsCategoryHeader
      category={category}
      activeTab={activeTab}
      onTabChange={(tab) => {
        setActiveTab(tab);
        onTabChange(tab);
      }}
      idPrefix="settings-category"
      compact={compact}
    />
  );
}

describe('SettingsCategoryHeader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes a labeled tablist and exactly one keyboard entry linked to the content panel', () => {
    render(<Harness initialTab="models" />);

    expect(screen.getByRole('heading', { level: 1, name: '模型与 AI' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: '模型与 AI' })).toHaveAttribute('aria-orientation', 'horizontal');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    tabs.forEach((tab, index) => {
      expect(tab).toHaveAttribute('id', `settings-category-tab-${category.items[index].value}`);
      expect(tab).toHaveAttribute('aria-controls', 'settings-category-panel');
      expect(tab).toHaveAttribute('aria-selected', String(index === 1));
      expect(tab).toHaveAttribute('tabindex', index === 1 ? '0' : '-1');
    });
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
  });

  it('keeps labeled tabs available when the compact layout hides the title', () => {
    render(<Harness compact />);

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: '模型与 AI' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('activates clicked sections through the controlled callback', () => {
    const onTabChange = vi.fn();
    render(<Harness onTabChange={onTabChange} />);

    fireEvent.click(screen.getByRole('tab', { name: '参数调整' }));

    expect(onTabChange).toHaveBeenCalledExactlyOnceWith('params');
    expect(screen.getByRole('tab', { name: '参数调整' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '模型服务' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves focus and automatically activates with arrow keys, wrapping at either end', () => {
    const onTabChange = vi.fn();
    render(<Harness onTabChange={onTabChange} />);
    const [apis, models, params] = screen.getAllByRole('tab');
    apis.focus();

    fireEvent.keyDown(apis, { key: 'ArrowRight' });
    expect(models).toHaveFocus();
    expect(models).toHaveAttribute('aria-selected', 'true');
    expect(models).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(models, { key: 'ArrowLeft' });
    expect(apis).toHaveFocus();
    expect(apis).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(apis, { key: 'ArrowLeft' });
    expect(params).toHaveFocus();
    expect(params).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(params, { key: 'ArrowRight' });
    expect(apis).toHaveFocus();
    expect(onTabChange.mock.calls).toEqual([['models'], ['apis'], ['params'], ['apis']]);
  });

  it('Home and End activate the first and last tabs and prevent page scrolling', () => {
    const onTabChange = vi.fn();
    render(<Harness initialTab="models" onTabChange={onTabChange} />);
    const [apis, models, params] = screen.getAllByRole('tab');
    models.focus();

    expect(fireEvent.keyDown(models, { key: 'End' })).toBe(false);
    expect(params).toHaveFocus();
    expect(params).toHaveAttribute('aria-selected', 'true');

    expect(fireEvent.keyDown(params, { key: 'Home' })).toBe(false);
    expect(apis).toHaveFocus();
    expect(apis).toHaveAttribute('aria-selected', 'true');
    expect(onTabChange.mock.calls).toEqual([['params'], ['apis']]);
  });

  it('leaves vertical arrows, Tab, and modified shortcuts to the browser', () => {
    const onTabChange = vi.fn();
    render(<Harness onTabChange={onTabChange} />);
    const apis = screen.getByRole('tab', { name: '模型服务' });
    apis.focus();

    expect(fireEvent.keyDown(apis, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(apis, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(apis, { key: 'ArrowRight', altKey: true })).toBe(true);
    expect(onTabChange).not.toHaveBeenCalled();
    expect(apis).toHaveFocus();
  });

  it('reveals a section activated externally without stealing keyboard focus', () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const props = { category, idPrefix: 'settings-category', onTabChange: vi.fn() };
    const { rerender } = render(<SettingsCategoryHeader {...props} activeTab="apis" compact />);
    const originalFocus = document.activeElement;
    scrollIntoView.mockClear();

    rerender(<SettingsCategoryHeader {...props} activeTab="params" compact />);

    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' });
    expect(scrollIntoView.mock.instances[0]).toBe(screen.getByRole('tab', { name: '参数调整' }));
    expect(document.activeElement).toBe(originalFocus);
  });
});
