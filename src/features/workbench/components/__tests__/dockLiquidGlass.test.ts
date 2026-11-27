import { describe, it, expect } from 'vitest';
import { buildPillDisplacementImageData } from '../dockLiquidGlass';

describe('dockLiquidGlass', () => {
  it('生成等厚倒角位移图：中心平坦区恒等(128)，外圈倒角严格向内弯曲', () => {
    const { width, height, data } = buildPillDisplacementImageData(300, 56, 17);
    expect(width).toBe(300);
    expect(height).toBe(56);

    const pixelAt = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
    };

    // 中心区域恒等无畸变
    const center = pixelAt(150, 28);
    expect(center).toEqual({ r: 128, g: 128, b: 128, a: 255 });

    // 顶缘倒角：法线向上(ny<0)，向内折射向量 dy>0 → G > 128，且水平分量 R ≈ 128
    const topBezel = pixelAt(150, 2);
    expect(topBezel.g).toBeGreaterThan(150);
    expect(Math.abs(topBezel.r - 128)).toBeLessThanOrEqual(2);

    // 底缘倒角：向内折射 dy<0 → G < 128
    const bottomBezel = pixelAt(150, height - 3);
    expect(bottomBezel.g).toBeLessThan(106);

    // 左缘倒角：向内折射 dx>0 → R > 128（且与顶缘等厚，不被 300:56 长宽比拉伸）
    const leftBezel = pixelAt(2, 28);
    expect(leftBezel.r).toBeGreaterThan(150);
    // 左缘 20px 处已进入平坦内部区（倒角上限 15px），应恢复恒等 128
    const insideLeft = pixelAt(20, 28);
    expect(insideLeft.r).toBe(128);
    expect(insideLeft.g).toBe(128);
  });
});
