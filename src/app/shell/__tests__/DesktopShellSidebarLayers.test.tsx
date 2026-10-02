import React, { useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesktopShellSidebarLayers } from '../DesktopShellSidebarLayers';

describe('DesktopShellSidebarLayers', () => {
  it('mounts on first visit and preserves state through cross-kind navigation', () => {
    const mount = vi.fn();
    const unmount = vi.fn();
    function Panel({ name }: { name: string }) {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mount(name);
        return () => { unmount(name); };
      }, [name]);
      return <button onClick={() => setCount(count + 1)}>{name}:{count}</button>;
    }
    const layers = [
      ['main', <Panel name="main" />],
      ['settings', <Panel name="settings" />],
      ['todo', <Panel name="todo" />],
      ['desktop-page', <Panel name="desktop-page" />],
    ] as const;
    const view = render(<DesktopShellSidebarLayers activeKind="main" layers={layers} />);
    fireEvent.click(screen.getByRole('button', { name: 'main:0' }));
    expect(mount.mock.calls).toEqual([['main']]);

    for (const kind of ['settings', 'todo', 'desktop-page', 'main', 'settings', 'main']) {
      view.rerender(<DesktopShellSidebarLayers activeKind={kind} layers={layers} />);
      expect(screen.getAllByRole('button')).toHaveLength(1);
    }
    expect(screen.getByRole('button', { name: 'main:1' })).toBeDefined();
    expect(mount.mock.calls).toEqual([['main'], ['settings'], ['todo'], ['desktop-page']]);
    expect(unmount).not.toHaveBeenCalled();
    view.unmount();
    expect(unmount).toHaveBeenCalledTimes(4);
  });

  it('makes inactive sidebars inert and releases their focus', () => {
    const layers = [
      ['main', <input aria-label="session search" />],
      ['settings', <button>Settings</button>],
    ] as const;
    const view = render(<DesktopShellSidebarLayers activeKind="main" layers={layers} />);
    const input = screen.getByRole('textbox');
    input.focus();
    expect(document.activeElement).toBe(input);
    view.rerender(<DesktopShellSidebarLayers activeKind="settings" layers={layers} />);
    const main = view.container.querySelector<HTMLElement>('[data-sidebar-layer="main"]')!;
    expect(main.hidden).toBe(true);
    expect(main.inert).toBe(true);
    expect(main.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).not.toBe(input);
    view.rerender(<DesktopShellSidebarLayers activeKind="main" layers={layers} />);
    expect(main.hidden).toBe(false);
    expect(main.inert).toBe(false);
    expect(main.getAttribute('aria-hidden')).toBe('false');
  });

  it('does not render stable sidebar content during repeated switches', () => {
    const renderPanel = vi.fn();
    function Panel({ name }: { name: string }) {
      renderPanel(name);
      return <div>{name}</div>;
    }
    const layers = [
      ['main', <Panel name="main" />],
      ['settings', <Panel name="settings" />],
    ] as const;
    const view = render(<DesktopShellSidebarLayers activeKind="main" layers={layers} />);
    for (let count = 0; count < 5; count += 1) {
      view.rerender(<DesktopShellSidebarLayers activeKind="settings" layers={layers} />);
      view.rerender(<DesktopShellSidebarLayers activeKind="main" layers={layers} />);
    }
    expect(renderPanel.mock.calls).toEqual([['main'], ['settings']]);
  });
});
