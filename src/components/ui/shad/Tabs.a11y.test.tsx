import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Tabs, TabsContent, TabsList, TabsTrigger } from './Tabs';

const ID = 'RF-W09-shared-tabs-aria-semantics';

function Harness({
  initial = 'a',
  onTriggerClick,
  disabledB = false,
  orientation,
}: {
  initial?: string;
  onTriggerClick?: () => void;
  disabledB?: boolean;
  orientation?: 'horizontal' | 'vertical';
}) {
  const [value, setValue] = useState(initial);
  return (
    <Tabs value={value} onValueChange={setValue}>
      <TabsList aria-label="sections" aria-orientation={orientation}>
        <TabsTrigger value="a" onClick={onTriggerClick}>Alpha</TabsTrigger>
        <TabsTrigger value="b" disabled={disabledB}>Beta</TabsTrigger>
        <TabsTrigger value="c">Gamma</TabsTrigger>
      </TabsList>
      <TabsContent value="a">panel a</TabsContent>
      <TabsContent value="b">panel b</TabsContent>
      <TabsContent value="c">panel c</TabsContent>
    </Tabs>
  );
}

describe('shad Tabs semantics', () => {
  it(`${ID}: renders tablist/tab/tabpanel with selection state and roving tab stop`, () => {
    render(<Harness />);

    const list = screen.getByRole('tablist', { name: 'sections' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(list).toContainElement(tabs[0]);

    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    // 样式仍由 data-state 驱动，外观不变
    expect(tabs.map((tab) => tab.getAttribute('data-state'))).toEqual(['active', 'inactive', 'inactive']);

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('panel a');
    expect(tabs[0]).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tabs[0].id);
    expect(screen.getByRole('tabpanel', { name: 'Alpha' })).toBe(panel);
    expect(tabs[1]).not.toHaveAttribute('aria-controls');
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(3);
  });

  it(`${ID}: arrow keys, Home and End move focus and activate, wrapping and skipping disabled tabs`, () => {
    render(<Harness disabledB />);
    const [alpha, , gamma] = screen.getAllByRole('tab');

    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(gamma).toHaveFocus();
    expect(gamma).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel c');
    expect(gamma.tabIndex).toBe(0);
    expect(alpha.tabIndex).toBe(-1);

    fireEvent.keyDown(gamma, { key: 'ArrowRight' });
    expect(alpha).toHaveFocus();
    expect(alpha).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
    expect(gamma).toHaveFocus();

    fireEvent.keyDown(gamma, { key: 'Home' });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: 'End' });
    expect(gamma).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel c');
  });

  it(`${ID}: keyboard moves scroll the new tab to the nearest edge instead of focus's default centring`, () => {
    render(<Harness />);
    const [alpha, beta] = screen.getAllByRole('tab');
    const focus = vi.spyOn(beta, 'focus');
    const scrollIntoView = vi.spyOn(beta, 'scrollIntoView');

    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect(beta).toHaveFocus();
  });

  it(`${ID}: vertical lists use ArrowUp/ArrowDown; modifiers and other keys are left alone`, () => {
    render(<Harness orientation="vertical" />);
    const [alpha, beta] = screen.getAllByRole('tab');

    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown', metaKey: true });
    expect(alpha).toHaveFocus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    expect(beta).toHaveFocus();
    expect(beta).toHaveAttribute('aria-selected', 'true');
  });

  it(`${ID}: a trigger's own onClick no longer stops the tab from switching`, () => {
    const onTriggerClick = vi.fn();
    render(<Harness initial="b" onTriggerClick={onTriggerClick} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Alpha' }));
    expect(onTriggerClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel a');
  });

  it(`${ID}: when no tab matches the value the first tab stays reachable with Tab`, () => {
    render(<Harness initial="missing" />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs.every((tab) => tab.getAttribute('aria-selected') === 'false')).toBe(true);
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });

  it(`${ID}: caller-supplied roles, ids and key handling still win`, () => {
    const onKeyDown = vi.fn((event: React.KeyboardEvent) => event.preventDefault());
    render(
      <Tabs value="x">
        <TabsList role="presentation">
          <TabsTrigger value="x" id="custom-x" aria-controls="outside" tabIndex={0} onKeyDown={onKeyDown}>X</TabsTrigger>
          <TabsTrigger value="y">Y</TabsTrigger>
        </TabsList>
      </Tabs>
    );
    const x = screen.getByRole('tab', { name: 'X' });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(x).toHaveAttribute('id', 'custom-x');
    expect(x).toHaveAttribute('aria-controls', 'outside');

    x.focus();
    fireEvent.keyDown(x, { key: 'ArrowRight' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(x).toHaveFocus();
  });
});
