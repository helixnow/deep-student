import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SlotStore } from '../slots';
import { UiKernel } from '../kernel';
import { UiKernelProvider, useOptionalSlot, useSlotEntry } from '../react';

describe('per-slot subscriptions (W18 kernel gap 5)', () => {
  it('a slot subscriber is notified only for its own slot; global subscribers still see every change', () => {
    const slots = new SlotStore();
    slots.declare({ name: 'a', cardinality: 'list' });
    slots.declare({ name: 'b', cardinality: 'list' });
    const onA = vi.fn();
    const onB = vi.fn();
    const onAny = vi.fn();
    const offA = slots.subscribe('a', onA);
    slots.subscribe('b', onB);
    slots.subscribe(onAny);

    const revoke = slots.contribute('a', 'p', { id: 'x', value: 1 });
    expect([onA.mock.calls.length, onB.mock.calls.length, onAny.mock.calls.length]).toEqual([1, 0, 1]);
    slots.contribute('b', 'p', { id: 'y', value: 2 });
    expect([onA.mock.calls.length, onB.mock.calls.length, onAny.mock.calls.length]).toEqual([1, 1, 2]);
    offA();
    revoke();
    expect([onA.mock.calls.length, onB.mock.calls.length, onAny.mock.calls.length]).toEqual([1, 1, 3]);
  });

  it('useOptionalSlot does not run or re-render on other slots; useSlotEntry ignores other keys of its slot', () => {
    const kernel = new UiKernel();
    kernel.slots.declare({ name: 'a', cardinality: 'list' });
    kernel.slots.declare({ name: 'b', cardinality: 'list' });
    kernel.slots.declare({ name: 'k', cardinality: 'keyed' });
    const renders = { list: 0, entry: 0 };
    function List() {
      renders.list++;
      return <span>{useOptionalSlot<string>('a')!.map((e) => e.value).join(',')}</span>;
    }
    function Entry() {
      renders.entry++;
      return <span>{useSlotEntry<string>('k', 'one')?.value ?? '-'}</span>;
    }
    const view = render(<UiKernelProvider kernel={kernel}><List /><Entry /></UiKernelProvider>);
    const base = { ...renders };

    act(() => { kernel.slots.contribute('b', 'p', { id: 'b1', value: 'b' }); });
    act(() => { kernel.slots.contribute('k', 'p', { id: 'two', key: 'two', value: 'II' }); });
    expect(renders).toEqual(base);

    act(() => { kernel.slots.contribute('k', 'p', { id: 'one', key: 'one', value: 'I' }); });
    act(() => { kernel.slots.contribute('a', 'p', { id: 'a1', value: 'A' }); });
    expect(renders).toEqual({ list: base.list + 1, entry: base.entry + 1 });
    expect(view.container.textContent).toBe('AI');
    view.unmount();
  });
});
