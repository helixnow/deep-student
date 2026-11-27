import { createElement, useRef } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import {
  computeRegionLuminance,
  parseBgPositionRatio,
  parseCssUrl,
  useAdaptiveGlassTone,
} from '../useAdaptiveGlassTone';

function ToneHarness({ testId }: { testId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useAdaptiveGlassTone(ref);
  return createElement('div', { ref, 'data-testid': testId });
}

function renderDesktopScene(initialPreset: string) {
  return render(
    createElement(
      'div',
      { 'data-wb-desktop': '' },
      createElement(
        'div',
        { className: 'wb-wallpaper-root' },
        createElement('div', {
          className: 'wb-wallpaper-pane',
          'data-wb-wallpaper-preset': initialPreset,
        }),
      ),
      createElement(
        'div',
        { className: 'wb-desktop-widget-column' },
        createElement('div', { 'data-testid': 'sibling-widget' }),
        createElement(ToneHarness, { testId: 'briefing-target' }),
      ),
    ),
  );
}

describe('useAdaptiveGlassTone helpers', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-wb-material');
  });

  it('正确解析 CSS background-image url 与 background-position', () => {
    expect(parseCssUrl('url("/wallpapers/study-os/mountain-mist.webp")')).toBe(
      '/wallpapers/study-os/mountain-mist.webp',
    );
    expect(parseCssUrl('none')).toBeNull();
    expect(parseBgPositionRatio('center 52%')).toEqual([0.5, 0.52]);
    expect(parseBgPositionRatio('left bottom')).toEqual([0, 1]);
  });

  it('按区域准确区分上方亮空与下方暗林感知明度', () => {
    const width = 10;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        // 上半区亮雾(230)，下半区深林(35, 52, 38)
        if (y < 5) {
          data[i] = 230;
          data[i + 1] = 232;
          data[i + 2] = 234;
        } else {
          data[i] = 35;
          data[i + 1] = 52;
          data[i + 2] = 38;
        }
        data[i + 3] = 255;
      }
    }

    const topLum = computeRegionLuminance({ data, width, height }, 0.6, 0.05, 0.35, 0.4);
    const bottomLum = computeRegionLuminance({ data, width, height }, 0.6, 0.6, 0.35, 0.35);

    expect(topLum).not.toBeNull();
    expect(bottomLum).not.toBeNull();
    expect(topLum!).toBeGreaterThan(0.8);
    expect(bottomLum!).toBeLessThan(0.25);
  });

  it('壁纸切换至深色渐变预设或亮色预设时立刻响应更新', async () => {
    document.documentElement.setAttribute('data-wb-material', 'full');
    const { container, getByTestId } = renderDesktopScene('aurora');

    const target = getByTestId('briefing-target');
    const wpRoot = container.querySelector('.wb-wallpaper-root')!;
    expect(target.getAttribute('data-wb-glass-tone')).toBeNull();

    // 追加深色 nebula 新壁纸 pane，立刻翻转成 dark 亮白字
    const nebulaPane = document.createElement('div');
    nebulaPane.className = 'wb-wallpaper-pane';
    nebulaPane.setAttribute('data-wb-wallpaper-preset', 'nebula');
    wpRoot.appendChild(nebulaPane);

    await waitFor(() => {
      expect(target.getAttribute('data-wb-glass-tone')).toBe('dark');
    });

    // 再切回亮色 aurora pane，立刻恢复深色字
    const auroraPane = document.createElement('div');
    auroraPane.className = 'wb-wallpaper-pane';
    auroraPane.setAttribute('data-wb-wallpaper-preset', 'aurora');
    wpRoot.appendChild(auroraPane);

    await waitFor(() => {
      expect(target.getAttribute('data-wb-glass-tone')).toBeNull();
    });
  });

  it('兄弟组件折叠触发父列变动时立即重采样', async () => {
    document.documentElement.setAttribute('data-wb-material', 'full');
    const { container, getByTestId } = renderDesktopScene('nebula');

    const sibling = getByTestId('sibling-widget');
    const target = getByTestId('briefing-target');
    await waitFor(() => {
      expect(target.getAttribute('data-wb-glass-tone')).toBe('dark');
    });

    // 先手动移除预设（不经由 wallpaper 节点外），仅由兄弟折叠属性触发父列观察器重评估
    const pane = container.querySelector<HTMLElement>('.wb-wallpaper-pane')!;
    pane.dataset.wbWallpaperPreset = 'aurora';
    sibling.setAttribute('data-collapsed', 'true');

    await waitFor(() => {
      expect(target.getAttribute('data-wb-glass-tone')).toBeNull();
    });
  });
});
