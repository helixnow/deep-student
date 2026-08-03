import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 📱 移动端 ModelPicker 搜索框紧凑化契约：
 * - 外壳收敛为 ~36px（min-h-9），避免 Input 自带的 44px 触控 min-h
 *   叠加外壳 padding 撑到 ~58px，挤压模型列表可视区域
 * - 输入字号必须 ≥16px：iOS WKWebView 聚焦 <16px 输入框会自动放大页面
 * - 桌面端外观不回归（py-1.5 + menu-shell 字号 token）
 */
describe('ModelPicker mobile search compactness', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/ModelPicker.tsx'),
    'utf-8'
  );

  it('uses a compact ~36px search shell on mobile while keeping desktop padding', () => {
    expect(source).toContain("isMobile ? 'min-h-9 py-1' : 'py-1.5'");
  });

  it('strips the 44px touch min-height from the inner Input on mobile', () => {
    expect(source).toContain('!min-h-0');
  });

  it('keeps mobile input font size at 16px to prevent iOS focus auto-zoom', () => {
    expect(source).toContain(
      "isMobile ? '!min-h-0 text-[16px] leading-5' : 'text-[var(--menu-shell-font-size)]'"
    );
    // 防回归：移动端分支不得再出现 <16px 的输入字号
    expect(source).not.toMatch(/isMobile\s*\?\s*'[^']*text-\[1[0-5]px\]/);
  });
});
