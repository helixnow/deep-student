/**
 * useMarqueeSelection — RF 框选 props + selection 映射
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SelectionMode } from '@xyflow/react';
import type { MindMapStoreApi } from '../../store';
import {
  getMarqueeSelectionPreset,
  mapSelectionNodeIds,
  MARQUEE_SELECTION_AGGRESSIVE,
  MARQUEE_SELECTION_CONSERVATIVE,
  useMarqueeSelection,
} from '../useMarqueeSelection';

function mockStoreApi(selection: string[] = []): MindMapStoreApi {
  const setSelection = vi.fn((ids: string[]) => {
    state.selection = ids;
  });
  const state = {
    selection,
    setSelection,
  };
  return {
    getState: () => state,
  } as unknown as MindMapStoreApi;
}

describe('mapSelectionNodeIds / presets', () => {
  it('从 RF params 提取 node ids', () => {
    expect(
      mapSelectionNodeIds({
        nodes: [
          { id: 'a', position: { x: 0, y: 0 }, data: {} },
          { id: 'b', position: { x: 1, y: 1 }, data: {} },
        ],
      }),
    ).toEqual(['a', 'b']);
    expect(mapSelectionNodeIds({ nodes: [] })).toEqual([]);
  });

  it('aggressive / conservative 预设符合 RF12 API', () => {
    expect(MARQUEE_SELECTION_AGGRESSIVE).toMatchObject({
      selectionOnDrag: true,
      selectionMode: SelectionMode.Partial,
      panOnDrag: [1, 2],
      selectionKeyCode: null,
      panActivationKeyCode: 'Space',
    });
    expect(MARQUEE_SELECTION_CONSERVATIVE).toMatchObject({
      selectionOnDrag: false,
      selectionMode: SelectionMode.Partial,
      panOnDrag: true,
      selectionKeyCode: 'Shift',
    });
    expect(getMarqueeSelectionPreset('aggressive')).toBe(MARQUEE_SELECTION_AGGRESSIVE);
    expect(getMarqueeSelectionPreset('conservative')).toBe(MARQUEE_SELECTION_CONSERVATIVE);
  });
});

describe('useMarqueeSelection', () => {
  it('默认 aggressive：返回可 spread 的 ReactFlow props', () => {
    const api = mockStoreApi();
    const { result } = renderHook(() => useMarqueeSelection(api));

    expect(result.current.selectionOnDrag).toBe(true);
    expect(result.current.selectionMode).toBe(SelectionMode.Partial);
    expect(result.current.panOnDrag).toEqual([1, 2]);
    expect(result.current.selectionKeyCode).toBeNull();
    expect(typeof result.current.onSelectionChange).toBe('function');
  });

  it('conservative variant', () => {
    const api = mockStoreApi();
    const { result } = renderHook(() =>
      useMarqueeSelection(api, { variant: 'conservative' }),
    );

    expect(result.current.selectionOnDrag).toBe(false);
    expect(result.current.selectionKeyCode).toBe('Shift');
    expect(result.current.panOnDrag).toBe(true);
  });

  it('onSelectionChange 把 RF 选中 ids 同步进 store.setSelection', () => {
    const api = mockStoreApi([]);
    const { result } = renderHook(() => useMarqueeSelection(api));

    result.current.onSelectionChange({
      nodes: [
        { id: 'n1', position: { x: 0, y: 0 }, data: {} },
        { id: 'n2', position: { x: 1, y: 1 }, data: {} },
      ],
      edges: [],
    });

    expect(api.getState().setSelection).toHaveBeenCalledWith(['n1', 'n2']);
    expect(api.getState().selection).toEqual(['n1', 'n2']);
  });

  it('ids 未变时不重复调用 setSelection', () => {
    const api = mockStoreApi(['n1']);
    const { result } = renderHook(() => useMarqueeSelection(api));

    result.current.onSelectionChange({
      nodes: [{ id: 'n1', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });

    expect(api.getState().setSelection).not.toHaveBeenCalled();
  });

  it('清空选区时 setSelection([])', () => {
    const api = mockStoreApi(['n1', 'n2']);
    const { result } = renderHook(() => useMarqueeSelection(api));

    result.current.onSelectionChange({ nodes: [], edges: [] });
    expect(api.getState().setSelection).toHaveBeenCalledWith([]);
  });
});
