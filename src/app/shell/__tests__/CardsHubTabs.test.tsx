/**
 * 闪卡中心分区切换控件 + 移动端顶栏附属行契约。
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardsHubTabs } from '../CardsHubTabs';
import {
  MobileHeaderActiveViewSync,
  MobileHeaderNavProvider,
  MobileHeaderProvider,
  useMobileHeader,
} from '@/components/layout/MobileHeaderContext';
import { MobileInFlowHeader } from '@/components/layout/UnifiedMobileHeader';

afterEach(() => cleanup());

describe('CardsHubTabs', () => {
  it.each([
    ['flashcards', '复习'],
    ['task-dashboard', '制卡'],
    ['template-management', '模板'],
  ] as const)('marks the tab for %s as selected', (view, label) => {
    render(<CardsHubTabs variant="titlebar" currentView={view} onNavigate={() => undefined} />);

    expect(screen.getByRole('radiogroup', { name: '闪卡分区' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('navigates to the legacy view id of the chosen tab', () => {
    const onNavigate = vi.fn();
    render(<CardsHubTabs variant="mobile" currentView="flashcards" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('radio', { name: '模板' }));
    expect(onNavigate).toHaveBeenCalledWith('template-management');
    fireEvent.click(screen.getByRole('radio', { name: '制卡' }));
    expect(onNavigate).toHaveBeenCalledWith('task-dashboard');
  });

  it('renders nothing outside the hub', () => {
    const { container } = render(
      <CardsHubTabs variant="titlebar" currentView="chat-v2" onNavigate={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

const HeaderProbe: React.FC<{ showBackArrow?: boolean; hidden?: boolean }> = ({ showBackArrow, hidden }) => {
  useMobileHeader('flashcards', {
    title: '今日',
    showMenu: !showBackArrow,
    showBackArrow,
    hidden,
    onMenuClick: () => undefined,
  }, [showBackArrow, hidden]);
  return <MobileInFlowHeader />;
};

const renderHeader = (props: { showBackArrow?: boolean; hidden?: boolean }) => render(
  <MobileHeaderProvider>
    <MobileHeaderActiveViewSync activeView="flashcards" />
    <MobileHeaderNavProvider
      value={{ accessory: <CardsHubTabs variant="mobile" currentView="flashcards" onNavigate={() => undefined} /> }}
    >
      <HeaderProbe {...props} />
    </MobileHeaderNavProvider>
  </MobileHeaderProvider>,
);

describe('MobileInFlowHeader accessory row', () => {
  it('renders the hub tabs below a root-state header', () => {
    const { container } = renderHeader({});
    expect(container.querySelector('[data-mobile-shell="header-accessory"]')).not.toBeNull();
    expect(screen.getByRole('radio', { name: '复习' })).toHaveAttribute('aria-checked', 'true');
  });

  it('yields to sub-page headers that show a back arrow (review session, editors)', () => {
    const { container } = renderHeader({ showBackArrow: true });
    expect(container.querySelector('[data-mobile-shell="header-accessory"]')).toBeNull();
  });

  it('yields when the page hides the header', () => {
    const { container } = renderHeader({ hidden: true });
    expect(container.querySelector('[data-mobile-shell="header-accessory"]')).toBeNull();
  });
});
