import { describe, expect, it } from 'vitest';
import * as kernel from '../kernel';
import * as plugin from '../plugin';
import * as service from '../ui-service';

describe('ui-kernel/kernel.ts as the import site', () => {
  it('keeps the runtime exports it had before plugin.ts and ui-service.ts were split out', () => {
    expect(Object.keys(kernel).sort()).toEqual(['BUILTIN_SLOTS', 'STRICT_COMMUNITY_NAMESPACES', 'UiCorePluginError', 'UiKernel', 'UiService', 'defineUiPlugin']);
    expect(kernel.defineUiPlugin).toBe(plugin.defineUiPlugin);
    expect(kernel.UiService).toBe(service.UiService);
    expect(kernel.BUILTIN_SLOTS).toBe(service.BUILTIN_SLOTS);
  });
});
