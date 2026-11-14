// @vitest-environment node
/**
 * views 懒加载工厂（W38 契约）：普通视图原样返回 component；懒视图按 load 恒等缓存 React.lazy；
 * 取组件不重建、不订阅，地图辅助按 key 取。
 */
import { describe, expect, it } from 'vitest';
import type { ShellView, ShellViewProps } from '../contracts/shell';
import { isLazyShellView, lazyShellViewComponent, resolveShellViewComponent, shellViewComponents } from '../shell-view';
import type { SlotEntry } from '../slots';

const Plain = (_props: ShellViewProps) => null;
const plain: ShellView = { id: 'dashboard', titleKey: 't', component: Plain };
const load = async () => ({ default: Plain });
const lazyView = { id: 'stats', titleKey: 't', load };

describe('views lazy factory', () => {
  it('detects lazy views and returns the eager component untouched', () => {
    expect(isLazyShellView(plain)).toBe(false);
    expect(isLazyShellView(lazyView)).toBe(true);
    expect(resolveShellViewComponent(plain)).toBe(Plain);
  });

  it('caches one lazy component per load function', () => {
    const first = resolveShellViewComponent(lazyView);
    const second = lazyShellViewComponent(load);
    expect(first).toBe(second);
    expect(first).not.toBe(Plain);
    expect(lazyShellViewComponent(async () => ({ default: Plain }))).not.toBe(first);
  });

  it('maps slot entries to components by key', () => {
    const entries = [
      { key: 'dashboard', value: plain, order: 10 },
      { key: 'stats', value: lazyView, order: 20 },
    ] as unknown as SlotEntry<ShellView | typeof lazyView>[];
    const components = shellViewComponents(entries);
    expect(components.get('dashboard')).toBe(Plain);
    expect(components.get('stats')).toBe(resolveShellViewComponent(lazyView));
  });
});
