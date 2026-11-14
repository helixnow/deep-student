import { describe, expect, it } from 'vitest';
import * as sdk from '../index';
import { sharedModuleSource } from '../../ui-kernel/shared';

// 运行时导出即社区插件经 import map 拿到的 `@deepstudent/ui`；增删需要同步 README 与版本说明。
const RUNTIME_EXPORTS = [
  'BUILTIN_SLOTS',
  'DS_ANCHOR_SCHEME',
  'DS_ANCHOR_VERSION',
  'DS_EXCERPT_MIME',
  'DsButton',
  'DsDialog',
  'SegmentedControl',
  'SlotOutlet',
  'UI_KERNEL_API_VERSION',
  'UI_PLATFORMS',
  'contributeAll',
  'contribution',
  'createPluginStore',
  'definePlugin',
  'defineSlot',
  'defineUiPlugin',
  'fnv1a64Hex',
  'formatAnchorShortLocator',
  'hasExcerptMime',
  'invalidateShellViewComponent',
  'isLazyShellView',
  'isSemanticAnchorUri',
  'parseSemanticAnchor',
  'readExcerptDrag',
  'resolveShellViewComponent',
  'sanitizeExcerptDragPayload',
  'serializeSemanticAnchor',
  'startExcerptDrag',
  'useNavigate',
  'useOptionalSlot',
  'usePlatform',
  'usePluginScope',
  'usePluginStorage',
  'usePluginStore',
  'useSlot',
  'useSlotEntry',
  'useT',
  'withPluginScope',
];

describe('@deepstudent/ui public API', () => {
  it('exports exactly the documented runtime names (v1 names kept)', () => {
    expect(Object.keys(sdk).sort()).toEqual([...RUNTIME_EXPORTS].sort());
  });

  it('is fully reachable through the shared-module import map for community plugins', () => {
    const source = sharedModuleSource('@deepstudent/ui', sdk);
    for (const name of RUNTIME_EXPORTS) expect(source).toContain(`export const ${name} = m["${name}"];`);
  });

  it('definePlugin defaults to API version 2 without changing defineUiPlugin', () => {
    expect(sdk.definePlugin({ meta: { id: 'p' }, apply() {} }).meta).toEqual({ id: 'p', apiVersion: 2 });
    expect(sdk.defineUiPlugin({ meta: { id: 'p' }, apply() {} }).meta).toEqual({ id: 'p' });
    expect(sdk.UI_KERNEL_API_VERSION).toBe(2);
  });
});
