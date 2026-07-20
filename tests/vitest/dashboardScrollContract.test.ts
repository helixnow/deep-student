import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 总览（dashboard）滚动契约。
 *
 * 背景（2026-07 移动端审计）：app.css 存在全局规则
 * `main { height: 100dvh; max-height: 100dvh; overflow: hidden; }`（窗口装饰所需）。
 * SOTADashboardLite 曾把页面内容包在嵌套的 `<main class="sota-content">` 里，
 * 该全局规则把内容钳死在一屏高并裁掉溢出，外层 CustomScrollArea 的
 * 可滚动距离只剩顶栏高度差（移动端 56px），表现为「总览页无法滚动」。
 *
 * 契约：
 * 1. app.css 的全局 main 规则仍然存在（一旦移除，本测试提醒重新评估各页面补偿样式）；
 * 2. SOTADashboardLite 不得再渲染嵌套 <main>（页面级 main 由 App 壳唯一提供）。
 */

const dashboardSource = readFileSync(
  resolve(process.cwd(), 'src/components/SOTADashboardLite.tsx'),
  'utf-8',
);
const appCssSource = readFileSync(
  resolve(process.cwd(), 'src/shared/styles/app.css'),
  'utf-8',
);

describe('dashboard scroll contract', () => {
  it('app.css still pins top-level <main> to the viewport (context for this contract)', () => {
    expect(appCssSource).toMatch(/main\s*\{[^}]*height:\s*100dvh;[^}]*\}/);
  });

  it('SOTADashboardLite must not nest a <main> element inside the scroll viewport', () => {
    expect(dashboardSource).not.toMatch(/<main[\s>]/);
    // 滚动内容容器仍在（改为非 main 元素承载）
    expect(dashboardSource).toContain('className="sota-content"');
  });
});
