/**
 * `portable.ts` is the entry chat takes agent-workspace values from when it must also load on mobile:
 * its runtime closure (`import type` excluded) must not reach Node-specific deps, and each export is the api.ts value.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import * as api from '../api.ts';
import * as portable from '../portable.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe('agent-workspace portable.ts', () => {
  it('the runtime closure of host/plugins/agent-workspace/portable.ts is free of Node-specific deps', () => {
    expect(checkModulesClosure(ROOT, ['host/plugins/agent-workspace/portable.ts'])).toEqual([]);
  });

  it('every portable export is the value api.ts publishes', () => {
    for (const [name, value] of Object.entries(portable)) {
      expect(Reflect.get(api, name), name).toBe(value);
    }
  });
});
