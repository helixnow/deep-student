import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopHeaderActiveViewSync,
  DesktopHeaderProvider,
  useDesktopHeader,
  useDesktopHeaderContextSafe,
} from '../DesktopHeaderContext';
import { DesktopBreadcrumbBar } from '../DesktopBreadcrumbBar';
import { DesktopHeaderSearch } from '../DesktopHeaderSearch';

afterEach(() => cleanup());

function HeaderDisplay() {
  const ctx = useDesktopHeaderContextSafe();
  if (!ctx?.config) return <div data-testid="empty-header">empty</div>;
  return (
    <div>
      {ctx.config.breadcrumbs ? (
        <DesktopBreadcrumbBar items={ctx.config.breadcrumbs} meta={ctx.config.meta} />
      ) : null}
      {ctx.config.actions ? <div data-testid="header-actions">{ctx.config.actions}</div> : null}
    </div>
  );
}

function ViewProbe({ viewId, label, enabled = true }: { viewId: string; label: string; enabled?: boolean }) {
  useDesktopHeader(
    viewId,
    {
      breadcrumbs: [{ id: `${viewId}-root`, label }],
      meta: `${viewId}-meta`,
    },
    [label, viewId],
    enabled,
  );
  return null;
}

describe('DesktopHeaderContext', () => {
  it('isolates registered configs by activeView across keep-alive views', () => {
    const { rerender } = render(
      <DesktopHeaderProvider>
        <DesktopHeaderActiveViewSync activeView="todo" />
        <ViewProbe viewId="todo" label="待办" />
        <ViewProbe viewId="skills-management" label="技能管理" />
        <HeaderDisplay />
      </DesktopHeaderProvider>,
    );

    expect(screen.getByText('待办')).toBeInTheDocument();
    expect(screen.getByText('todo-meta')).toBeInTheDocument();
    expect(screen.queryByText('技能管理')).not.toBeInTheDocument();

    rerender(
      <DesktopHeaderProvider>
        <DesktopHeaderActiveViewSync activeView="skills-management" />
        <ViewProbe viewId="todo" label="待办" />
        <ViewProbe viewId="skills-management" label="技能管理" />
        <HeaderDisplay />
      </DesktopHeaderProvider>,
    );

    expect(screen.getByText('技能管理')).toBeInTheDocument();
    expect(screen.getByText('skills-management-meta')).toBeInTheDocument();
    expect(screen.queryByText('待办')).not.toBeInTheDocument();
  });

  it('does not overwrite active config when embedded instance sets enabled=false', () => {
    render(
      <DesktopHeaderProvider>
        <DesktopHeaderActiveViewSync activeView="media" />
        <ViewProbe viewId="media" label="音视频" enabled={true} />
        <ViewProbe viewId="media" label="嵌入窗口" enabled={false} />
        <HeaderDisplay />
      </DesktopHeaderProvider>,
    );

    expect(screen.getByText('音视频')).toBeInTheDocument();
    expect(screen.queryByText('嵌入窗口')).not.toBeInTheDocument();
  });
});

describe('DesktopBreadcrumbBar', () => {
  it('renders parent click targets, separators, current label and meta', () => {
    const onRootClick = vi.fn();
    render(
      <DesktopBreadcrumbBar
        items={[
          { id: 'root', label: '音视频', onClick: onRootClick },
          { id: 'item', label: '高等数学第一讲' },
        ]}
        meta="12 项"
      />,
    );

    const rootBtn = screen.getByRole('button', { name: '音视频' });
    fireEvent.click(rootBtn);
    expect(onRootClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText('高等数学第一讲')).toBeInTheDocument();
    expect(screen.getByText('12 项')).toBeInTheDocument();
  });

  it('compresses breadcrumbs deeper than 3 levels with ellipsis trigger', () => {
    render(
      <DesktopBreadcrumbBar
        items={[
          { id: '0', label: '资源库', onClick: vi.fn() },
          { id: '1', label: '考研', onClick: vi.fn() },
          { id: '2', label: '数学', onClick: vi.fn() },
          { id: '3', label: '线代' },
        ]}
      />,
    );

    expect(screen.getByRole('button', { name: '资源库' })).toBeInTheDocument();
    expect(screen.getByText('…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '数学' })).toBeInTheDocument();
    expect(screen.getByText('线代')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '考研' })).not.toBeInTheDocument();
  });
});

describe('DesktopHeaderSearch', () => {
  function SearchHarness() {
    const [q, setQ] = useState('');
    return (
      <DesktopHeaderSearch
        value={q}
        onChange={setQ}
        placeholder="搜索任务"
      />
    );
  }

  it('starts collapsed and expands on click, then collapses on Escape', () => {
    render(<SearchHarness />);

    const trigger = screen.getByRole('button', { name: '搜索任务' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    const input = screen.getByRole('searchbox', { name: '搜索任务' });
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '线代' } });
    expect(input).toHaveValue('线代');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('button', { name: '搜索任务' })).toBeInTheDocument();
  });
});
