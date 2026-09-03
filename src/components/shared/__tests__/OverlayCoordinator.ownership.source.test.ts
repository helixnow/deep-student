import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const coordinatorSource = readFileSync(path.join(here, '../OverlayCoordinator.tsx'), 'utf8');
const ownershipSource = readFileSync(path.join(here, '../overlayOwnership.ts'), 'utf8');

describe('OverlayCoordinator ownership source contract', () => {
  it('keeps the pre-existing tooltip-suppression API untouched (additive extension only)', () => {
    // 原有 API：一个都不能少，语义不变（计数 + 版本号驱动 tooltip 抑制）
    for (const member of [
      'activeInteractiveOverlayCount',
      'tooltipsSuppressed',
      'tooltipDismissVersion',
      'dismissTooltips',
      'registerInteractiveOverlay',
    ]) {
      expect(coordinatorSource).toContain(member);
    }
    expect(coordinatorSource).toContain('tooltipsSuppressed: activeInteractiveOverlayCount > 0');
    expect(coordinatorSource).toContain('setActiveInteractiveOverlayCount((count) => count + 1)');
    expect(coordinatorSource).toContain('Math.max(0, count - 1)');
  });

  it('adds the ownership API on the same provider tree', () => {
    for (const member of ['registerOwnedOverlay', 'isOwnedOverlayTarget', 'listOwnedOverlayOwnerIds']) {
      expect(coordinatorSource).toContain(member);
    }
    // 与 tooltip 抑制共用同一个 OverlayCoordinatorContext，不另起 Provider
    expect(coordinatorSource.match(/createContext</g)).toHaveLength(1);
    expect(coordinatorSource.match(/export function \w*Provider/g)).toEqual(['export function OverlayCoordinatorProvider']);
  });

  it('keeps ownership registration render-free (ref-backed store, no setState)', () => {
    // 登记表放 ref：registerOwnedOverlay 不得触发 re-render，也不得影响 tooltip 计数
    expect(coordinatorSource).toContain('useRef(createOwnedOverlayStore())');
    const registerBlock = coordinatorSource.slice(
      coordinatorSource.indexOf('const registerOwnedOverlay'),
      coordinatorSource.indexOf('const isOwnedOverlayTarget'),
    );
    expect(registerBlock).not.toContain('setActiveInteractiveOverlayCount');
    expect(registerBlock).not.toContain('setTooltipDismissVersion');
  });

  it('documents fail-empty fallback semantics when no provider is mounted', () => {
    // 无 Provider：归属查询恒 false / 空列表，调用方回落到自己的 contains/closest 兜底
    expect(coordinatorSource).toContain('isOwnedOverlayTarget: () => false');
    expect(coordinatorSource).toContain('listOwnedOverlayOwnerIds: () => []');
    expect(coordinatorSource).toContain('registerOwnedOverlay: () => () => {}');
    expect(coordinatorSource).toMatch(/fail-empty|空登记表/);
  });

  it('delegates matching to the framework-free overlayOwnership module', () => {
    expect(coordinatorSource).toContain("from './overlayOwnership'");
    // 纯函数层不得依赖 React（保证可被非组件代码 / rust 侧桥接逻辑复用）
    expect(ownershipSource).not.toContain("from 'react'");
    for (const fn of [
      'createOwnedOverlayStore',
      'registerOwnedOverlayEntry',
      'isEventInsideOwnedOverlay',
      'listOwnedOverlayOwnerIds',
      'resolveEventTargetElement',
    ]) {
      expect(ownershipSource).toContain(`export function ${fn}`);
    }
    // element 与 selector 两种登记形态都必须支持
    expect(ownershipSource).toContain('element?: Element | null');
    expect(ownershipSource).toContain('selector?: string');
    expect(ownershipSource).toContain('closest(spec.selector)');
  });
});
