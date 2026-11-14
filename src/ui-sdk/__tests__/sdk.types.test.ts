// @vitest-environment node
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTypeTest } from '../../ui-kernel/__tests__/typecheck-helper';
import { TYPE_CONTRACT_TIMEOUT_MS } from '../../ui-kernel/__tests__/typecheck-budget';

describe('SDK compile-time contracts', () => {
  it('checks static contributions, v2 meta, plugin stores, SlotOutlet render props, settings sections and menu rows against their declared types', async () => {
    const result = await runTypeTest(path.resolve(__dirname, '../typetests/sdk.typetest.ts'));
    expect(result.clean).toEqual([]);
    expect(result.tags).toEqual(['static-shape', 'static-builtin-nav', 'meta-platform', 'meta-api-version', 'meta-field-outside-meta', 'store-shape', 'outlet-render', 'settings-navigation', 'menu-context']);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.errors['static-shape']).toMatch(/Type 'number' is not assignable to type 'string'/);
    expect(result.errors['static-builtin-nav']).toMatch(/'viewId' is missing/);
    expect(result.errors['meta-platform']).toMatch(/"tablet"/);
    expect(result.errors['meta-api-version']).toMatch(/Type '1' is not assignable to type '2'/);
    expect(result.errors['meta-field-outside-meta']).toMatch(/'devOnly' does not exist/);
    expect(result.errors['store-shape']).toMatch(/Type 'string' is not assignable to type 'number'/);
    expect(result.errors['outlet-render']).toMatch(/Property 'missing' does not exist/);
    expect(result.errors['settings-navigation']).toMatch(/is missing the following properties.*legacyGroup/);
    expect(result.errors['menu-context']).toMatch(/not assignable to parameter of type 'AppMenuDesktop'/);
  }, TYPE_CONTRACT_TIMEOUT_MS);
});
