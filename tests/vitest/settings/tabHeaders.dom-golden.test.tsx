/**
 * DOM evidence for SettingsCategoryHeader and ComponentRecoveryShell giving up their hand-written tab semantics for the
 * shared Tabs (RF-W09-shared-tabs-aria-semantics). The goldens were captured from the hand-written versions
 * (`W09_CAPTURE_TAB_GOLDENS=1`); the DOM after a click and after an arrow key must stay the same.
 */
import fs from 'node:fs';
import path from 'node:path';
import React, { useState } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { serializeDom } from '@/ui-plugins/testing/dom-snapshot';
import { SettingsCategoryHeader } from '@/features/settings/components/SettingsCategoryHeader';
import type { SettingsSidebarCategory } from '@/features/settings/components/useSettingsNavigation';

vi.mock('@/utils/platform', () => ({ isMobilePlatform: () => false }));
vi.mock('@/components/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('@/features/data-recovery/dataRecoveryApi', () => ({
  exportStartupRecoveryReport: vi.fn(async () => null),
  retryRecoveryStartup: vi.fn(),
}));

const { ComponentRecoveryShell } = await import('@/features/data-recovery/ComponentRecoveryShell');

const GOLDEN_DIR = path.resolve(process.cwd(), 'tests/vitest/settings/__golden__');
const CAPTURE = process.env.W09_CAPTURE_TAB_GOLDENS === '1';

function golden(name: string, current: string): string {
  const file = path.join(GOLDEN_DIR, name);
  if (CAPTURE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, current, { flag: 'wx' });
  }
  return fs.readFileSync(file, 'utf8');
}

const Icon = () => null;
const CATEGORY: SettingsSidebarCategory = {
  value: 'models',
  label: '模型与 AI',
  icon: Icon,
  items: [
    { value: 'apis', label: '模型服务', icon: Icon, tourId: 'settings-tab-apis' },
    { value: 'models', label: '模型分配', icon: Icon, tourId: 'settings-tab-models' },
    { value: 'params', label: '参数', icon: Icon },
  ],
};

function SettingsHost() {
  const [tab, setTab] = useState('apis');
  return (
    <>
      <SettingsCategoryHeader category={CATEGORY} activeTab={tab} onTabChange={setTab} idPrefix="settings-nav" />
      <div id="settings-nav-panel" role="tabpanel" aria-labelledby={`settings-nav-tab-${tab}`}>{tab}</div>
    </>
  );
}

const snapshots = (root: HTMLElement, tabs: () => HTMLElement[], stepName: (index: number) => string) => {
  const out: string[] = [`# initial\n${serializeDom(root)}`];
  fireEvent.click(tabs()[1]);
  out.push(`# ${stepName(1)} clicked\n${serializeDom(root)}`);
  tabs()[1].focus();
  fireEvent.keyDown(tabs()[1], { key: 'ArrowRight' });
  out.push(`# ArrowRight from ${stepName(1)}\n${serializeDom(root)}\nfocused: ${document.activeElement?.textContent}`);
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
  out.push(`# Home\n${serializeDom(root)}\nfocused: ${document.activeElement?.textContent}`);
  return `${out.join('\n\n')}\n`;
};

describe('tab headers keep their DOM on the shared Tabs', () => {
  it('SettingsCategoryHeader: tablist, tabs and the outside panel link, through click and keyboard', () => {
    const { container } = render(<SettingsHost />);
    const tabs = () => Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    const current = snapshots(container, tabs, (i) => CATEGORY.items[i].label);
    expect(current).toBe(golden('settingsCategoryHeader.dom.txt', current));
  });

  it('ComponentRecoveryShell: the two tabs and their panels, through click and keyboard', () => {
    const { container } = render(
      <ComponentRecoveryShell components={[{ component: 'notes', status: 'degraded', reason: 'locked' }]} />,
    );
    const root = container.querySelector<HTMLElement>('[role="tablist"]')!.parentElement!;
    const tabs = () => Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]'));
    const current = snapshots(root, tabs, (i) => ['status', 'next'][i]);
    expect(current).toBe(golden('componentRecoveryShell.tabs.dom.txt', current));
  });
});
