// @vitest-environment jsdom
import { Component, Suspense, useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateShellViewComponent, resolveShellViewComponent } from '../../ui-sdk';
import type { LazyShellView, ShellView } from '../contracts/shell';

class RetryBoundary extends Component<{ children: ReactNode; onRetry(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <button onClick={() => { this.props.onRetry(); this.setState({ failed: false }); }}>Retry</button>
      : this.props.children;
  }
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('lazy view retry', () => {
  it('renders a rejected load again after explicit invalidation and keeps the recovered result cached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Recovered = () => <div>Recovered view</div>;
    const load = vi.fn<LazyShellView['load']>()
      .mockRejectedValueOnce(new Error('first load failed'))
      .mockResolvedValue({ default: Recovered });
    const view: LazyShellView = { id: 'retry', titleKey: 'retry', load };
    const first = resolveShellViewComponent(view);
    expect(load).not.toHaveBeenCalled();
    expect(resolveShellViewComponent(view)).toBe(first);

    function Host() {
      const [, setGeneration] = useState(0);
      const View = resolveShellViewComponent(view);
      return <RetryBoundary onRetry={() => {
        invalidateShellViewComponent(view);
        const next = resolveShellViewComponent(view);
        expect(next).not.toBe(first);
        expect(resolveShellViewComponent(view)).toBe(next);
        expect(load).toHaveBeenCalledTimes(1);
        setGeneration((value) => value + 1);
      }}><Suspense fallback={<div>Loading</div>}><View /></Suspense></RetryBoundary>;
    }

    const mounted = render(<Host />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByText('Recovered view');
    expect(load).toHaveBeenCalledTimes(2);
    const recovered = resolveShellViewComponent(view);
    mounted.unmount();
    render(<Host />);
    await screen.findByText('Recovered view');
    expect(resolveShellViewComponent(view)).toBe(recovered);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the shared load identity, does not load eagerly, and leaves eager views untouched', () => {
    const load = vi.fn(async () => ({ default: () => null }));
    const otherLoad = vi.fn(async () => ({ default: () => null }));
    const view: LazyShellView = { id: 'a', titleKey: 'a', load };
    const alias: LazyShellView = { ...view, id: 'alias' };
    const other: LazyShellView = { ...view, id: 'other', load: otherLoad };
    const eager: ShellView = { id: 'eager', titleKey: 'eager', component: () => null };
    const first = resolveShellViewComponent(view);
    const otherComponent = resolveShellViewComponent(other);
    expect(resolveShellViewComponent(alias)).toBe(first);
    invalidateShellViewComponent(eager);
    expect(resolveShellViewComponent(eager)).toBe(eager.component);
    expect(resolveShellViewComponent(view)).toBe(first);
    invalidateShellViewComponent(alias);
    const next = resolveShellViewComponent(view);
    expect(next).not.toBe(first);
    expect(resolveShellViewComponent(alias)).toBe(next);
    expect(resolveShellViewComponent(other)).toBe(otherComponent);
    expect(load).not.toHaveBeenCalled();
    expect(otherLoad).not.toHaveBeenCalled();
  });
});
