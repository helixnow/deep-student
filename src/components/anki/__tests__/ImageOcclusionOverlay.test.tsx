/**
 * ImageOcclusionOverlay 最小渲染层组件测试。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ImageOcclusionOverlay } from '../ImageOcclusionOverlay';
import type { OcclusionSpec } from '../utils/imageOcclusion';

const spec: OcclusionSpec = {
  imageRef: 'vfs://images/diagram.png',
  boxes: [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: '左心房', clozeIndex: 1 },
    { x: 0.5, y: 0.1, w: 0.2, h: 0.2, label: '右心室', clozeIndex: 2 },
    // 与盒 1 同组（Anki 语义：同 clozeIndex 一起揭开）
    { x: 0.1, y: 0.6, w: 0.2, h: 0.2, label: '左心房备注', clozeIndex: 1 },
  ],
};

describe('ImageOcclusionOverlay', () => {
  it('初始全部遮挡，百分比定位', () => {
    render(<ImageOcclusionOverlay spec={spec} />);
    const masked = screen.getAllByTestId('occlusion-box-masked');
    expect(masked).toHaveLength(3);
    expect(screen.queryAllByTestId('occlusion-box-revealed')).toHaveLength(0);
    // jsdom 会把 10.0000% 归一化为 10%
    expect(masked[0].style.left).toBe('10%');
    expect(masked[0].style.width).toBe('20%');
  });

  it('点击揭开同 clozeIndex 组，其余保持遮挡，并回调 onReveal', () => {
    const onReveal = vi.fn();
    render(<ImageOcclusionOverlay spec={spec} onReveal={onReveal} />);
    // clozeIndex=1 组内有两个盒，共享同一 aria-label，点其一即揭开整组
    fireEvent.click(screen.getAllByLabelText('揭开遮挡区域 1')[0]);
    // clozeIndex=1 的两个盒一起揭开，显示标签
    const revealed = screen.getAllByTestId('occlusion-box-revealed');
    expect(revealed).toHaveLength(2);
    expect(screen.getByText('左心房')).toBeTruthy();
    expect(screen.getByText('左心房备注')).toBeTruthy();
    expect(screen.getAllByTestId('occlusion-box-masked')).toHaveLength(1);
    expect(onReveal).toHaveBeenCalledWith(1);
  });

  it('revealAll 全部揭开；受控 revealedIndices 优先于内部状态', () => {
    const { rerender } = render(<ImageOcclusionOverlay spec={spec} revealAll />);
    expect(screen.getAllByTestId('occlusion-box-revealed')).toHaveLength(3);

    rerender(<ImageOcclusionOverlay spec={spec} revealedIndices={new Set([2])} />);
    expect(screen.getAllByTestId('occlusion-box-revealed')).toHaveLength(1);
    expect(screen.getByText('右心室')).toBeTruthy();
  });
});
