import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTabs } from '../components/WorkspaceTabStrip';
import type { WorkspaceTab } from '../workspaceTreeModel';

function renderTabs(tabs: WorkspaceTab[]) {
  return render(
    <WorkspaceTabs
      tabs={tabs}
      activeKey={tabs[0]?.key ?? null}
      rightTabKey={null}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
      onOpenContextMenu={vi.fn()}
      contextMenuKey={null}
      sidebarWidth="0px"
      saveStates={new Map()}
    />,
  );
}

describe('WorkspaceTabs multi-tab same-prefix disambiguation (S1-06)', () => {
  it('renders distinct, distinguishable visible labels and full title/aria-label for 4+ same-prefix notes', () => {
    const tabs: WorkspaceTab[] = [
      { key: 'note:1', type: 'note', id: '1', title: 'ProjectX-Architecture-Alpha' },
      { key: 'note:2', type: 'note', id: '2', title: 'ProjectX-Architecture-Beta' },
      { key: 'note:3', type: 'note', id: '3', title: 'ProjectX-Architecture-Gamma' },
      { key: 'note:4', type: 'note', id: '4', title: 'ProjectX-Architecture-Delta' },
    ];

    renderTabs(tabs);

    const renderedTabs = screen.getAllByRole('tab');
    expect(renderedTabs).toHaveLength(4);

    const visibleLabels = renderedTabs.map((tab) => tab.querySelector('[data-notes-tab-label]')?.textContent ?? '');
    expect(new Set(visibleLabels).size).toBe(4);

    renderedTabs.forEach((tabEl, idx) => {
      const fullTitle = tabs[idx]!.title;
      expect(tabEl).toHaveAttribute('title', fullTitle);
      expect(tabEl).toHaveAttribute('aria-label', fullTitle);
      const labelEl = tabEl.querySelector('[data-notes-tab-label]');
      expect(labelEl).toHaveAttribute('data-disambiguated', 'true');
      const suffix = fullTitle.split('-').pop()!;
      expect(labelEl?.querySelector('.notes-tab-label-suffix')?.textContent).toBe(suffix);
    });
  });

  it('keeps unrelated tabs intact while disambiguating a same-prefix group in the same tab strip', () => {
    const tabs: WorkspaceTab[] = [
      { key: 'note:misc', type: 'note', id: 'misc', title: 'Daily Scratchpad' },
      { key: 'note:a', type: 'note', id: 'a', title: 'Organic-Chemistry-Chapter-Alkanes' },
      { key: 'note:b', type: 'note', id: 'b', title: 'Organic-Chemistry-Chapter-Alkenes' },
      { key: 'note:c', type: 'note', id: 'c', title: 'Organic-Chemistry-Chapter-Alkynes' },
      { key: 'note:d', type: 'note', id: 'd', title: 'Organic-Chemistry-Chapter-Aromatics' },
    ];

    renderTabs(tabs);

    const miscTab = screen.getByRole('tab', { name: 'Daily Scratchpad' });
    expect(miscTab).toHaveAttribute('title', 'Daily Scratchpad');
    expect(miscTab.querySelector('[data-notes-tab-label]')).toHaveAttribute('data-disambiguated', 'false');
    expect(miscTab.querySelector('[data-notes-tab-label]')?.textContent).toBe('Daily Scratchpad');

    const chemSuffixes = ['Alkanes', 'Alkenes', 'Alkynes', 'Aromatics'];
    for (const suffix of chemSuffixes) {
      const fullTitle = `Organic-Chemistry-Chapter-${suffix}`;
      const tab = screen.getByRole('tab', { name: fullTitle });
      expect(tab).toHaveAttribute('title', fullTitle);
      expect(tab.querySelector('[data-notes-tab-label]')?.textContent).toContain(suffix);
    }
  });
});
