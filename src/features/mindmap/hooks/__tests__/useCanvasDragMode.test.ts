/**
 * useCanvasDragMode / useCanvasWheelMode — 画布交互偏好（localStorage + 跨实例同步）
 *
 * 注意：偏好为模块级单例，测试间通过 set 复位而非 reset 模块。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  getCanvasDragMode,
  getCanvasWheelMode,
  setCanvasDragMode,
  setCanvasWheelMode,
  useCanvasDragMode,
  useCanvasWheelMode,
} from '../useCanvasDragMode';

afterEach(() => {
  // 复位到默认，避免测试间串扰
  setCanvasDragMode('pan');
  setCanvasWheelMode('pan');
  window.localStorage.removeItem('mindmap:canvas-drag-mode');
  window.localStorage.removeItem('mindmap:canvas-wheel-mode');
});

describe('useCanvasDragMode', () => {
  it('默认 pan（拖空白平移）', () => {
    expect(getCanvasDragMode()).toBe('pan');
  });

  it('set 后持久化到 localStorage 并同步到所有实例', () => {
    const a = renderHook(() => useCanvasDragMode());
    const b = renderHook(() => useCanvasDragMode());

    act(() => {
      a.result.current[1]('select');
    });

    expect(a.result.current[0]).toBe('select');
    expect(b.result.current[0]).toBe('select');
    expect(window.localStorage.getItem('mindmap:canvas-drag-mode')).toBe('select');
  });
});

describe('useCanvasWheelMode', () => {
  it('默认 pan（双指平移 + pinch/Ctrl+滚轮缩放，对齐平台习惯）', () => {
    expect(getCanvasWheelMode()).toBe('pan');
  });

  it('可切换回旧「滚轮缩放」并持久化、跨实例同步', () => {
    const a = renderHook(() => useCanvasWheelMode());
    const b = renderHook(() => useCanvasWheelMode());

    act(() => {
      a.result.current[1]('zoom');
    });

    expect(a.result.current[0]).toBe('zoom');
    expect(b.result.current[0]).toBe('zoom');
    expect(window.localStorage.getItem('mindmap:canvas-wheel-mode')).toBe('zoom');

    act(() => {
      b.result.current[1]('pan');
    });
    expect(a.result.current[0]).toBe('pan');
  });

  it('两个偏好互不影响', () => {
    setCanvasWheelMode('zoom');
    expect(getCanvasDragMode()).toBe('pan');
    setCanvasDragMode('select');
    expect(getCanvasWheelMode()).toBe('zoom');
  });
});
