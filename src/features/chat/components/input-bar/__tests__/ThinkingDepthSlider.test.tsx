import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { ThinkingDepthSlider } from '../ThinkingDepthSlider';
import type { DeepSeekReasoningOption } from '@/utils/deepseekReasoningControls';

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterAll(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown> | string) => {
      if (typeof options === 'string') return options;
      if (typeof options === 'object' && typeof options.defaultValue === 'string') {
        return options.defaultValue;
      }
      return _key;
    },
  }),
}));

const OPENAI_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'low', labelKey: 'settings:api.modal.reasoning.effort.low', defaultLabel: 'Low' },
  { value: 'medium', labelKey: 'settings:api.modal.reasoning.effort.medium', defaultLabel: 'Medium' },
  { value: 'high', labelKey: 'settings:api.modal.reasoning.effort.high', defaultLabel: 'High' },
  { value: 'xhigh', labelKey: 'settings:api.modal.reasoning.effort.xhigh', defaultLabel: 'XHigh' },
];

const V4_OPTIONS: DeepSeekReasoningOption[] = [
  { value: 'high', labelKey: 'settings:api.modal.deepseek.depth.high', defaultLabel: 'High' },
  { value: 'max', labelKey: 'settings:api.modal.deepseek.depth.max', defaultLabel: 'Max' },
];

function renderSlider(overrides: Partial<React.ComponentProps<typeof ThinkingDepthSlider>> = {}) {
  const props: React.ComponentProps<typeof ThinkingDepthSlider> = {
    options: OPENAI_OPTIONS,
    value: 'medium',
    enabled: true,
    onChange: vi.fn(),
    offLabel: '关闭',
    efficientLabel: '更高效',
    smartLabel: '更智能',
    ...overrides,
  };
  return { ...render(<ThinkingDepthSlider {...props} />), props };
}

describe('ThinkingDepthSlider', () => {
  it('exposes an off stop plus one stop per depth option', () => {
    renderSlider();
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '4');
    expect(slider).toHaveAttribute('aria-valuenow', '2');
    expect(slider).toHaveAttribute('aria-valuetext', 'Medium');
  });

  it('sits on the off stop when thinking is disabled', () => {
    renderSlider({ enabled: false });
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    expect(slider).toHaveAttribute('aria-valuetext', '关闭');
    expect(screen.getByTestId('thinking-depth-slider')).toHaveAttribute('data-off');
  });

  it('steps up through depth values with the keyboard', () => {
    const { props } = renderSlider({ value: 'medium' });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(props.onChange).toHaveBeenCalledWith('high');
  });

  it('emits off when stepping below the lowest depth', () => {
    const { props } = renderSlider({ value: 'low' });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });
    expect(props.onChange).toHaveBeenCalledWith('off');
  });

  it('jumps to both ends with Home and End', () => {
    const { props } = renderSlider({ value: 'medium' });
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(props.onChange).toHaveBeenCalledWith('xhigh');
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(props.onChange).toHaveBeenCalledWith('off');
  });

  it('re-enables thinking from the off stop by stepping right', () => {
    const { props } = renderSlider({ enabled: false });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(props.onChange).toHaveBeenCalledWith('low');
  });

  it('snaps a value from another control kind to the nearest available depth', () => {
    // openai-effort 的 medium 切到 v4-effort（只有 high/max）时就近吸附到 high
    renderSlider({ options: V4_OPTIONS, value: 'medium' });
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuemax', '2');
    expect(slider).toHaveAttribute('aria-valuenow', '1');
    expect(slider).toHaveAttribute('aria-valuetext', 'High');
  });

  it('keeps max selectable on the v4 control kind', () => {
    const { props } = renderSlider({ options: V4_OPTIONS, value: 'high' });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(props.onChange).toHaveBeenCalledWith('max');
  });

  it('does not fire onChange when stepping past the top end', () => {
    const { props } = renderSlider({ options: V4_OPTIONS, value: 'max' });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('drops a stale drag position when the available depth type changes', () => {
    const { container, rerender, props } = renderSlider({ value: 'medium' });
    const slider = screen.getByRole('slider');
    const rail = container.querySelector('.tds-rail');

    expect(rail).not.toBeNull();
    vi.spyOn(rail as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 4,
      width: 100,
      height: 4,
      toJSON: () => ({}),
    });

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      clientX: { value: 100 },
      pointerId: { value: 1 },
    });
    fireEvent(slider, pointerDown);
    expect(slider).toHaveAttribute('aria-valuenow', '4');

    rerender(
      <ThinkingDepthSlider
        {...props}
        options={V4_OPTIONS}
        value="high"
      />
    );

    expect(slider).toHaveAttribute('aria-valuemax', '2');
    expect(slider).toHaveAttribute('aria-valuenow', '1');
    expect(slider).toHaveAttribute('aria-valuetext', 'High');
  });

  it('keeps drag gestures inside the slider instead of bubbling to window drag surfaces', () => {
    const onParentPointerDown = vi.fn();
    const onParentMouseDown = vi.fn();
    const props: React.ComponentProps<typeof ThinkingDepthSlider> = {
      options: OPENAI_OPTIONS,
      value: 'medium',
      enabled: true,
      onChange: vi.fn(),
      offLabel: '关闭',
      efficientLabel: '更高效',
      smartLabel: '更智能',
    };
    const { container } = render(
      <div onPointerDown={onParentPointerDown} onMouseDown={onParentMouseDown}>
        <ThinkingDepthSlider {...props} />
      </div>
    );
    const root = screen.getByTestId('thinking-depth-slider');
    const slider = screen.getByRole('slider');
    const rail = container.querySelector('.tds-rail');

    expect(rail).not.toBeNull();
    vi.spyOn(rail as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 4,
      width: 100,
      height: 4,
      toJSON: () => ({}),
    });

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      clientX: { value: 50 },
      pointerId: { value: 1 },
    });
    fireEvent(slider, pointerDown);
    fireEvent.mouseDown(slider);
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(slider, contextMenu);

    expect(root).toHaveAttribute('data-no-drag');
    expect(onParentPointerDown).not.toHaveBeenCalled();
    expect(onParentMouseDown).not.toHaveBeenCalled();
    expect(contextMenu.defaultPrevented).toBe(true);
  });

  it('renders a thick canvas surface without a persistent depth label or icon', () => {
    const { container } = renderSlider();

    expect(container.querySelector('canvas.tds-canvas')).toBeInTheDocument();
    expect(container.querySelector('.tds-header')).not.toBeInTheDocument();
    expect(container.querySelector('.tds-icon')).not.toBeInTheDocument();
    expect(container.querySelector('.tds-drag-label-slot')).not.toBeInTheDocument();
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();
    expect(screen.queryByText('更高效')).not.toBeInTheDocument();
    expect(screen.queryByText('更智能')).not.toBeInTheDocument();
  });

  it('shows completed stops as pale dots behind the white thumb', () => {
    const { container } = renderSlider({ value: 'xhigh' });
    const ticks = Array.from(container.querySelectorAll('.tds-tick'));

    expect(ticks).toHaveLength(5);
    expect(ticks.slice(0, 4).every((tick) => tick.getAttribute('data-lit') === 'true')).toBe(true);
    expect(ticks[4]).toHaveAttribute('data-lit', 'false');
  });

  it('pulls a continuous drag position nonlinearly toward a nearby depth stop', () => {
    const { container } = renderSlider({ value: 'medium' });
    const root = screen.getByTestId('thinking-depth-slider');
    const slider = screen.getByRole('slider');
    const rail = container.querySelector('.tds-rail');

    expect(rail).not.toBeNull();
    vi.spyOn(rail as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 4,
      left: 0,
      top: 4,
      right: 100,
      bottom: 28,
      width: 100,
      height: 24,
      toJSON: () => ({}),
    });

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      clientX: { value: 52 },
      clientY: { value: 16 },
      pointerId: { value: 1 },
    });
    fireEvent(slider, pointerDown);

    const visualPercent = Number.parseFloat(root.style.getPropertyValue('--tds-pct'));
    expect(visualPercent).toBeGreaterThan(50);
    expect(visualPercent).toBeLessThan(52);
  });

  it('slightly lifts the thumb only after a stationary long press begins on the thumb', () => {
    vi.useFakeTimers();
    const { container } = renderSlider({ value: 'medium' });
    const root = screen.getByTestId('thinking-depth-slider');
    const slider = screen.getByRole('slider');
    const rail = container.querySelector('.tds-rail');
    const thumb = container.querySelector('.tds-thumb');

    expect(rail).not.toBeNull();
    expect(thumb).not.toBeNull();
    vi.spyOn(rail as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 4,
      left: 0,
      top: 4,
      right: 100,
      bottom: 28,
      width: 100,
      height: 24,
      toJSON: () => ({}),
    });
    vi.spyOn(thumb as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 34,
      y: 0,
      left: 34,
      top: 0,
      right: 66,
      bottom: 32,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      clientX: { value: 50 },
      clientY: { value: 16 },
      pointerId: { value: 1 },
    });
    fireEvent(slider, pointerDown);

    expect(root).not.toHaveAttribute('data-thumb-held');
    act(() => {
      vi.advanceTimersByTime(179);
    });
    expect(root).not.toHaveAttribute('data-thumb-held');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(root).toHaveAttribute('data-thumb-held');

    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(root).not.toHaveAttribute('data-thumb-held');
  });

  it('does not lift the thumb when a long press begins on the rail', () => {
    vi.useFakeTimers();
    const { container } = renderSlider({ value: 'medium' });
    const root = screen.getByTestId('thinking-depth-slider');
    const slider = screen.getByRole('slider');
    const rail = container.querySelector('.tds-rail');
    const thumb = container.querySelector('.tds-thumb');

    expect(rail).not.toBeNull();
    expect(thumb).not.toBeNull();
    vi.spyOn(rail as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 4,
      left: 0,
      top: 4,
      right: 100,
      bottom: 28,
      width: 100,
      height: 24,
      toJSON: () => ({}),
    });
    vi.spyOn(thumb as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 34,
      y: 0,
      left: 34,
      top: 0,
      right: 66,
      bottom: 32,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      clientX: { value: 90 },
      clientY: { value: 16 },
      pointerId: { value: 1 },
    });
    fireEvent(slider, pointerDown);
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(root).not.toHaveAttribute('data-thumb-held');
    expect(screen.queryByText('更高效')).not.toBeInTheDocument();
    expect(screen.queryByText('更智能')).not.toBeInTheDocument();
  });

  it('cancels the thumb lift when the pointer moves before the long press completes', () => {
    vi.useFakeTimers();
    const { container } = renderSlider({ value: 'medium' });
    const root = screen.getByTestId('thinking-depth-slider');
    const slider = screen.getByRole('slider');
    const rail = container.querySelector('.tds-rail');
    const thumb = container.querySelector('.tds-thumb');

    expect(rail).not.toBeNull();
    expect(thumb).not.toBeNull();
    vi.spyOn(rail as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 4,
      left: 0,
      top: 4,
      right: 100,
      bottom: 28,
      width: 100,
      height: 24,
      toJSON: () => ({}),
    });
    vi.spyOn(thumb as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 34,
      y: 0,
      left: 34,
      top: 0,
      right: 66,
      bottom: 32,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      clientX: { value: 50 },
      clientY: { value: 16 },
      pointerId: { value: 1 },
    });
    fireEvent(slider, pointerDown);

    const pointerMove = new Event('pointermove', { bubbles: true });
    Object.defineProperties(pointerMove, {
      clientX: { value: 64 },
      clientY: { value: 16 },
      pointerId: { value: 1 },
    });
    fireEvent(slider, pointerMove);
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(root).not.toHaveAttribute('data-thumb-held');
  });

  it('reveals only endpoint depth guidance while the circular thumb is long-held', () => {
    vi.useFakeTimers();
    const { container } = renderSlider({ value: 'medium' });
    const slider = screen.getByRole('slider');
    const rail = container.querySelector('.tds-rail');
    const thumb = container.querySelector('.tds-thumb');

    expect(rail).not.toBeNull();
    expect(thumb).not.toBeNull();
    expect(container.querySelector('.tds-drag-label-slot')).not.toBeInTheDocument();
    expect(screen.queryByText('更高效')).not.toBeInTheDocument();
    expect(screen.queryByText('更智能')).not.toBeInTheDocument();
    vi.spyOn(rail as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 4,
      left: 0,
      top: 4,
      right: 100,
      bottom: 28,
      width: 100,
      height: 24,
      toJSON: () => ({}),
    });
    vi.spyOn(thumb as HTMLDivElement, 'getBoundingClientRect').mockReturnValue({
      x: 34,
      y: 0,
      left: 34,
      top: 0,
      right: 66,
      bottom: 32,
      width: 32,
      height: 32,
      toJSON: () => ({}),
    });
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      clientX: { value: 50 },
      clientY: { value: 16 },
      pointerId: { value: 1 },
    });
    fireEvent(slider, pointerDown);

    expect(screen.queryByText('Medium')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(179);
    });
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const labelSlot = container.querySelector('.tds-drag-label-slot');
    expect(labelSlot).toBeInTheDocument();
    expect(screen.getByText('更高效').parentElement).toBe(labelSlot);
    expect(screen.getByText('更智能').parentElement).toBe(labelSlot);
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();

    fireEvent.pointerUp(slider, { pointerId: 1 });

    expect(screen.queryByText('Medium')).not.toBeInTheDocument();
    expect(screen.queryByText('更高效')).not.toBeInTheDocument();
    expect(screen.queryByText('更智能')).not.toBeInTheDocument();
    expect(container.querySelector('.tds-drag-label-slot')).not.toBeInTheDocument();
  });
});
